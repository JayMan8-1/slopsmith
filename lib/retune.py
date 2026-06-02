"""Pitch-shift a CDLC's audio to E standard tuning.

Only works for uniform tunings (all strings shifted by the same amount),
e.g. Eb standard (-1), D standard (-2), C# standard (-3).
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

log = logging.getLogger("slopsmith.lib.retune")

from patcher import unpack_psarc, pack_psarc
from audio import _vgmstream_cmd

RSCLI = Path(os.environ.get("RSCLI_PATH", str(Path(__file__).parent / "tools" / "rscli" / "RsCli")))


def get_tuning(psarc_path: str) -> tuple[list[int], bool]:
    """Extract tuning from a PSARC. Returns (offsets, is_uniform).
    Prefers guitar (Lead/Rhythm/Combo) arrangements over Bass."""
    tmp = Path(tempfile.mkdtemp(prefix="rs_tune_"))
    try:
        unpack_psarc(psarc_path, str(tmp))
        # Also try reading from manifest JSON (works for SNG-only files)
        guitar_tuning = None
        fallback_tuning = None
        # Check manifests first
        for jf in sorted(tmp.rglob("*.json")):
            try:
                import json
                data = json.loads(jf.read_text())
                for k, v in data.get("Entries", {}).items():
                    attrs = v.get("Attributes", {})
                    arr_name = attrs.get("ArrangementName", "")
                    tun = attrs.get("Tuning", {})
                    if not tun or arr_name in ("Vocals", "ShowLights", "JVocals"):
                        continue
                    offsets = [tun.get(f"string{i}", 0) for i in range(6)]
                    if arr_name in ("Lead", "Rhythm", "Combo"):
                        if guitar_tuning is None:
                            guitar_tuning = offsets
                    elif fallback_tuning is None:
                        fallback_tuning = offsets
            except Exception:
                continue
        # Check XMLs as fallback
        if guitar_tuning is None and fallback_tuning is None:
            for xml_path in sorted(tmp.rglob("*.xml")):
                try:
                    tree = ET.parse(xml_path)
                    root = tree.getroot()
                except ET.ParseError:
                    continue
                if root.tag != "song":
                    continue
                arr = root.find("arrangement")
                if arr is not None and arr.text:
                    low = arr.text.lower().strip()
                    if low in ("vocals", "showlights", "jvocals"):
                        continue
                tuning = root.find("tuning")
                if tuning is not None:
                    offsets = [int(tuning.get(f"string{i}", "0")) for i in range(6)]
                    fname = xml_path.stem.lower()
                    if "lead" in fname or "rhythm" in fname or "combo" in fname:
                        if guitar_tuning is None:
                            guitar_tuning = offsets
                    elif fallback_tuning is None:
                        fallback_tuning = offsets
        best = guitar_tuning or fallback_tuning or [0] * 6
        is_uniform = len(set(best)) == 1
        return best, is_uniform
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _pitch_shift_wem(wem_path: Path, semitones: int, on_progress=None) -> bool:
    """Decode a WEM, pitch-shift it, and replace the original file.

    Returns True if successful.
    """
    wav_decoded = wem_path.with_suffix(".decoded.wav")
    wav_shifted = wem_path.with_suffix(".shifted.wav")
    ogg_out = wem_path.with_suffix(".shifted.ogg")

    # Step 1: Decode WEM to WAV
    decoded = False
    vgmstream = _vgmstream_cmd()
    if vgmstream:
        r = None
        try:
            r = subprocess.run(
                [vgmstream, "-o", str(wav_decoded), str(wem_path)],
                # `errors="replace"` — without it a decoder that emits
                # non-UTF-8 bytes raises UnicodeDecodeError after the
                # subprocess finishes, which would slip past the
                # OSError/timeout handler below and skip the ffmpeg
                # fallback. Matches the audio.py decode helper.
                capture_output=True, text=True, errors="replace", timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.warning("vgmstream decode failed for %s: %s", wem_path.name, exc)
        if r is not None and r.returncode == 0 and wav_decoded.exists() and wav_decoded.stat().st_size > 100:
            decoded = True
            log.info("Decoded with vgmstream (%d bytes)", wav_decoded.stat().st_size)
            if on_progress:
                on_progress(f"Decoded: {wem_path.name}", 45)

    if not decoded and shutil.which("ffmpeg"):
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(wem_path), str(wav_decoded)],
            capture_output=True, text=True, errors="replace",
        )
        if r.returncode == 0 and wav_decoded.exists() and wav_decoded.stat().st_size > 100:
            decoded = True
            log.info("Decoded with ffmpeg (%d bytes)", wav_decoded.stat().st_size)
            if on_progress:
                on_progress(f"Decoded: {wem_path.name}", 45)

    if not decoded:
        log.warning("FAILED to decode %s", wem_path.name)
        # Cleanup
        for f in [wav_decoded, wav_shifted, ogg_out]:
            if f.exists():
                f.unlink()
        return False

    # Step 2: Pitch shift (rubberband preserves tempo, only shifts pitch)
    # Detect original sample rate to preserve it
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=sample_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", str(wav_decoded)],
        capture_output=True, text=True,
    )
    sample_rate = probe.stdout.strip() or "44100"

    factor = 2 ** (semitones / 12)
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(wav_decoded),
         "-af", f"rubberband=pitch={factor}",
         "-ar", sample_rate,
         "-q:a", "6", str(ogg_out)],
        capture_output=True, text=True,
    )
    wav_decoded.unlink()

    if r.returncode != 0 or not ogg_out.exists():
        log.warning("FAILED to pitch-shift: %s", r.stderr[-200:])
        for f in [wav_shifted, ogg_out]:
            if f.exists():
                f.unlink()
        return False

    log.info("Shifted %+d semitones (%d bytes)", semitones, ogg_out.stat().st_size)
    if on_progress:
        on_progress(f"Shifted: {wem_path.name}", 60)

    # Step 3: Replace original WEM with shifted OGG
    # (Rocksmith accepts OGG files with .wem extension)
    wem_path.unlink()
    shutil.move(str(ogg_out), str(wem_path))
    return True


def _is_instrumental_sng(sng_path: Path) -> bool:
    stem = sng_path.stem.lower()
    if "vocals" in stem or "showlights" in stem or "jvocals" in stem:
        return False
    return True


def _rscli_candidates() -> list[Path]:
    """Candidate RsCli paths aligned with song._convert_sng_to_xml discovery."""
    candidates: list[Path] = []
    if "RESOURCESPATH" in os.environ:
        candidates.append(Path(os.environ["RESOURCESPATH"]) / "bin" / "rscli" / "RsCli")
    env = os.environ.get("RSCLI_PATH", "").strip()
    if env:
        candidates.append(Path(env))
    candidates.append(RSCLI)
    candidates.append(Path(__file__).parent.parent / "tools" / "rscli" / "RsCli")
    path_bin = os.environ.get("PATH_BIN", "").strip()
    if path_bin:
        candidates.append(Path(path_bin) / "rscli" / "RsCli")
    candidates.extend([
        Path("/opt/rscli/RsCli"),
        Path("./rscli/RsCli"),
    ])
    seen: set[str] = set()
    ordered: list[Path] = []
    for p in candidates:
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(p)
    return ordered


def _require_rscli() -> Path:
    tried: list[str] = []
    for candidate in _rscli_candidates():
        tried.append(str(candidate))
        if candidate.exists():
            return candidate
    raise RuntimeError(
        "RsCli is required to retune SNG-only CDLC (RsCli not found). "
        f"Set RSCLI_PATH or install RsCli. Searched: {', '.join(tried)}"
    )


def _sng_platform(sng_paths: list[Path]) -> str:
    for sng_path in sng_paths:
        parts = str(sng_path).lower()
        if "/macos/" in parts or "/mac/" in parts:
            return "mac"
    return "pc"


def _ensure_arrangement_xmls(tmp: Path) -> None:
    """Ensure songs/arr/{stem}.xml exist for instrumental SNGs (SNG-only CDLC)."""
    sng_files = [p for p in sorted(tmp.rglob("*.sng")) if _is_instrumental_sng(p)]
    if not sng_files:
        return

    arr_dir = tmp / "songs" / "arr"
    missing = [s for s in sng_files if not (arr_dir / f"{s.stem}.xml").exists()]
    if not missing:
        return

    rscli = _require_rscli()
    arr_dir.mkdir(parents=True, exist_ok=True)
    platform = _sng_platform(sng_files)
    log.info("Converting %d arrangement SNG(s) to XML for retune...", len(missing))

    for sng_path in missing:
        xml_out = arr_dir / f"{sng_path.stem}.xml"
        result = subprocess.run(
            [str(rscli), "sng2xml", str(sng_path), str(xml_out), platform],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()[-500:]
            raise RuntimeError(f"sng2xml failed for {sng_path.name}: {detail}")

    still_missing = [s.name for s in missing if not (arr_dir / f"{s.stem}.xml").exists()]
    if still_missing:
        raise RuntimeError(
            "Failed to convert arrangement SNG to XML (sng2xml): " + ", ".join(still_missing)
        )


def _recompile_sngs_from_xml(tmp: Path, on_progress=None) -> None:
    """Write updated tuning from songs/arr/*.xml back into matching SNG binaries."""
    rscli = _require_rscli()
    for xml_path in sorted(tmp.rglob("songs/arr/*.xml")):
        try:
            root = ET.parse(xml_path).getroot()
        except ET.ParseError:
            continue
        if root.tag != "song":
            continue
        arr = root.find("arrangement")
        if arr is not None and arr.text:
            low = arr.text.lower().strip()
            if low in ("vocals", "showlights", "jvocals"):
                continue

        stem = xml_path.stem
        sng_path = tmp / "songs" / "bin" / "generic" / f"{stem}.sng"
        if not sng_path.exists():
            continue

        log.info("Recompiling SNG: %s", stem)
        if on_progress:
            on_progress(f"Recompiling SNG: {stem}", 80)
        result = subprocess.run(
            [str(rscli), "xml2sng", str(xml_path), str(sng_path)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()[-500:]
            raise RuntimeError(f"xml2sng failed for {stem}: {detail}")


def retune_to_standard(psarc_path: str, output_path: str = "", on_progress=None) -> str:
    """Pitch-shift a CDLC to E standard tuning.

    Args:
        psarc_path: Input .psarc file
        output_path: Output path (default: same name with _EStd suffix)
        on_progress: Optional callback(stage: str, pct: float) for progress events

    Returns:
        Path to the new .psarc file

    Raises:
        ValueError: If tuning is not uniform or already E standard
    """
    offsets, is_uniform = get_tuning(psarc_path)

    if all(o == 0 for o in offsets):
        raise ValueError("Already in E standard tuning")

    if not is_uniform:
        raise ValueError(
            f"Non-uniform tuning {offsets} — only uniform tunings supported. "
            f"E.g. Eb standard [-1,-1,-1,-1,-1,-1]"
        )

    semitones = -offsets[0]  # e.g. offset=-1 (Eb) → shift up by 1
    log.info("Tuning: %s → shifting %+d semitone(s)", offsets, semitones)

    tmp = Path(tempfile.mkdtemp(prefix="rs_retune_"))
    try:
        # Extract
        log.info("Extracting PSARC...")
        unpack_psarc(psarc_path, str(tmp))

        # SNG-only CDLC: materialize songs/arr/*.xml before tuning edits / xml2sng.
        _ensure_arrangement_xmls(tmp)

        # Pitch-shift all audio files
        shifted_count = 0
        for wem in sorted(tmp.rglob("*.wem")):
            log.info("Processing: %s", wem.name)
            if on_progress:
                on_progress(f"Processing: {wem.name}", 30)
            if _pitch_shift_wem(wem, semitones, on_progress=on_progress):
                shifted_count += 1

        if shifted_count == 0:
            raise RuntimeError("No audio files were successfully pitch-shifted")

        log.info("Shifted %d audio file(s)", shifted_count)

        # Update arrangement XMLs: set tuning to E standard
        for xml_path in sorted(tmp.rglob("*.xml")):
            try:
                tree = ET.parse(xml_path)
                root = tree.getroot()
            except ET.ParseError:
                continue
            if root.tag != "song":
                continue

            tuning_el = root.find("tuning")
            if tuning_el is not None:
                for i in range(6):
                    tuning_el.set(f"string{i}", "0")
                tree.write(xml_path, xml_declaration=True, encoding="UTF-8")
                log.info("Updated tuning: %s", xml_path.name)
                if on_progress:
                    on_progress(f"Updated tuning: {xml_path.name}", 70)

        # Recompile SNGs from updated XMLs (fail if any instrumental xml2sng fails).
        _recompile_sngs_from_xml(tmp, on_progress=on_progress)

        # Update JSON manifests
        for json_path in sorted(tmp.rglob("*.json")):
            try:
                data = json.loads(json_path.read_text())
                changed = False
                for entry in data.get("Entries", {}).values():
                    attrs = entry.get("Attributes", {})
                    if "Tuning" in attrs:
                        attrs["Tuning"] = {f"string{i}": 0 for i in range(6)}
                        changed = True
                if changed:
                    json_path.write_text(json.dumps(data, indent=2))
            except (json.JSONDecodeError, KeyError):
                pass

        # Repack
        log.info("Repacking PSARC...")
        if on_progress:
            on_progress("Repacking PSARC...", 90)
        if not output_path:
            p = Path(psarc_path)
            stem = p.stem
            if stem.endswith("_p"):
                stem = stem[:-2]
            output_path = str(p.parent / f"{stem}_EStd_p.psarc")

        pack_psarc(str(tmp), output_path)
        log.info("Created: %s", output_path)
        if on_progress:
            on_progress(f"Created: {output_path}", 95)
        return output_path

    finally:
        shutil.rmtree(tmp, ignore_errors=True)
