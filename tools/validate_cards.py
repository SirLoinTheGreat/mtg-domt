#!/usr/bin/env python3
"""Cross-validate cards.json against card image files in assets/cards/.

Checks:
- Every entry in cards.json has a matching PNG file
- Every PNG file has a matching entry in cards.json
- No duplicate collector numbers within a set
- Card count per set matches expected totals
"""

import argparse
import json
from pathlib import Path

# Expected card counts per set
EXPECTED_COUNTS = {
    "original": 22,
    "expansion": 45,
    "harrow": 54,
    "wonder": 22,
}

SET_DIRS = {
    "original": "assets/cards/original",
    "expansion": "assets/cards/expansion",
    "harrow": "assets/cards/harrow",
    "wonder": "assets/cards/wonder",
}


def load_cards_json(repo_root: Path) -> dict:
    """Load and parse cards.json from the data directory."""
    cards_path = repo_root / "data" / "cards.json"
    if not cards_path.exists():
        raise FileNotFoundError(f"cards.json not found at {cards_path}")
    with cards_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def get_png_files(repo_root: Path) -> dict[str, set[str]]:
    """Collect all PNG filenames by set directory."""
    png_files: dict[str, set[str]] = {}
    for set_name, set_dir in SET_DIRS.items():
        dir_path = repo_root / set_dir
        if dir_path.exists():
            png_files[set_name] = {
                f.name for f in dir_path.glob("*.png")
            }
        else:
            png_files[set_name] = set()
    return png_files


def validate(repo_root: Path) -> list[str]:
    """Run all validation checks. Returns a list of issue strings."""
    issues: list[str] = []

    # Load cards.json
    try:
        data = load_cards_json(repo_root)
    except FileNotFoundError as e:
        return [str(e)]

    cards = data.get("cards", [])
    meta = data.get("meta", {})

    # Get filesystem PNGs
    png_files = get_png_files(repo_root)

    # Build lookup from cards.json
    json_images: dict[str, set[str]] = {s: set() for s in SET_DIRS}
    collector_numbers: dict[str, list[str]] = {s: [] for s in SET_DIRS}

    for card in cards:
        set_name = card.get("set", "unknown")
        image_file = card.get("image_file", "")
        collector_num = card.get("collector_number", "")
        card_name = card.get("name", "UNNAMED")

        if set_name not in SET_DIRS:
            issues.append(f"Unknown set '{set_name}' for card '{card_name}'")
            continue

        # Track image file references
        if image_file:
            filename = Path(image_file).name
            json_images[set_name].add(filename)
        else:
            issues.append(f"Missing image_file for card '{card_name}'")

        # Track collector numbers
        if collector_num:
            collector_numbers[set_name].append(collector_num)

    # Check 1: JSON entries without matching PNG files
    for set_name in SET_DIRS:
        missing_pngs = json_images[set_name] - png_files.get(set_name, set())
        for filename in sorted(missing_pngs):
            issues.append(
                f"[{set_name}] JSON references '{filename}' but PNG not found"
            )

    # Check 2: PNG files without matching JSON entries
    for set_name in SET_DIRS:
        orphan_pngs = png_files.get(set_name, set()) - json_images[set_name]
        for filename in sorted(orphan_pngs):
            issues.append(
                f"[{set_name}] PNG '{filename}' exists but has no JSON entry"
            )

    # Check 3: Duplicate collector numbers
    for set_name, numbers in collector_numbers.items():
        seen: dict[str, int] = {}
        for num in numbers:
            seen[num] = seen.get(num, 0) + 1
        for num, count in seen.items():
            if count > 1:
                issues.append(
                    f"[{set_name}] Duplicate collector number '{num}' "
                    f"({count} cards)"
                )

    # Check 4: Card count vs meta
    total_json = len(cards)
    meta_total = meta.get("total_cards", 0)
    if meta_total and total_json != meta_total:
        issues.append(
            f"Meta says {meta_total} total cards but JSON has {total_json}"
        )

    # Check 5: Card count per set (excluding tokens/rules)
    for set_name in SET_DIRS:
        json_count = sum(
            1 for c in cards
            if c.get("set") == set_name and not c.get("is_token", False)
        )
        png_count = len(png_files.get(set_name, set()))
        if json_count != png_count:
            issues.append(
                f"[{set_name}] JSON has {json_count} non-token cards, "
                f"filesystem has {png_count} PNGs"
            )

    # Summary
    total_pngs = sum(len(v) for v in png_files.values())
    print(f"=== Validation Report ===")
    print(f"cards.json entries: {total_json}")
    print(f"PNG files found:    {total_pngs}")
    print(f"Sets checked:       {', '.join(SET_DIRS.keys())}")
    print()

    for set_name in SET_DIRS:
        json_count = sum(1 for c in cards if c.get("set") == set_name)
        png_count = len(png_files.get(set_name, set()))
        status = "OK" if json_count == png_count else "MISMATCH"
        print(f"  {set_name:12s}: {json_count:3d} JSON / {png_count:3d} PNG  [{status}]")

    print()

    if issues:
        print(f"Found {len(issues)} issue(s):")
        for issue in issues:
            print(f"  - {issue}")
    else:
        print("No issues found. All cards validated successfully.")

    return issues


def main():
    """Entry point for the validation script."""
    parser = argparse.ArgumentParser(
        description="Validate cards.json against card image files"
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).parent.parent,
        help="Path to the repository root (default: parent of tools/)",
    )
    args = parser.parse_args()

    issues = validate(args.repo_root)
    raise SystemExit(1 if issues else 0)


if __name__ == "__main__":
    main()
