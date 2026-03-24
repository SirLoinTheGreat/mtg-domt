#!/usr/bin/env python3
"""Generate analytics from cards.json.

Reports:
- Color identity distribution per set and overall
- Card type distribution
- Mana cost curve
- Keyword frequency
- Positive/negative sentiment ratio per set
"""

import argparse
import json
import re
from collections import Counter
from pathlib import Path


def load_cards(repo_root: Path) -> list[dict]:
    """Load cards from cards.json."""
    cards_path = repo_root / "data" / "cards.json"
    if not cards_path.exists():
        raise FileNotFoundError(f"cards.json not found at {cards_path}")
    with cards_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("cards", [])


def parse_cmc(mana_cost: str | None) -> int:
    """Calculate converted mana cost from MTG notation."""
    if not mana_cost:
        return 0
    total = 0
    symbols = re.findall(r"\{([^}]+)\}", mana_cost)
    for sym in symbols:
        if sym.isdigit():
            total += int(sym)
        elif sym in ("W", "U", "B", "R", "G", "C"):
            total += 1
        elif sym == "X":
            pass  # X counts as 0 for CMC
    return total


def color_distribution(cards: list[dict], set_filter: str | None = None) -> Counter:
    """Count color identity occurrences."""
    counter: Counter = Counter()
    for card in cards:
        if set_filter and card.get("set") != set_filter:
            continue
        if card.get("is_token"):
            continue
        colors = card.get("color_identity", [])
        if not colors:
            counter["Colorless"] += 1
        else:
            for color in colors:
                counter[color] += 1
    return counter


def type_distribution(cards: list[dict], set_filter: str | None = None) -> Counter:
    """Count card types."""
    counter: Counter = Counter()
    for card in cards:
        if set_filter and card.get("set") != set_filter:
            continue
        for card_type in card.get("types", []):
            counter[card_type] += 1
    return counter


def keyword_frequency(cards: list[dict]) -> Counter:
    """Count keyword occurrences across all cards."""
    counter: Counter = Counter()
    for card in cards:
        for keyword in card.get("keywords", []):
            counter[keyword] += 1
    return counter


def sentiment_ratio(cards: list[dict], set_filter: str | None = None) -> dict:
    """Calculate positive/negative/neutral ratio."""
    counts = {"positive": 0, "negative": 0, "neutral": 0}
    for card in cards:
        if set_filter and card.get("set") != set_filter:
            continue
        if card.get("is_token"):
            continue
        sentiment = card.get("sentiment", "neutral")
        counts[sentiment] = counts.get(sentiment, 0) + 1
    return counts


def mana_curve(cards: list[dict]) -> Counter:
    """Count cards at each CMC."""
    counter: Counter = Counter()
    for card in cards:
        if card.get("is_token"):
            continue
        cmc = parse_cmc(card.get("mana_cost"))
        counter[cmc] += 1
    return counter


def print_counter(title: str, counter: Counter, total: int | None = None):
    """Pretty-print a counter with percentages."""
    print(f"\n### {title}")
    if not counter:
        print("  (no data)")
        return
    if total is None:
        total = sum(counter.values())
    for key, count in counter.most_common():
        pct = (count / total * 100) if total else 0
        bar = "#" * int(pct / 2)
        print(f"  {str(key):20s} {count:4d}  ({pct:5.1f}%)  {bar}")


def generate_markdown(cards: list[dict]) -> str:
    """Generate a markdown report."""
    lines = ["# Card Statistics Report", ""]

    sets = ["original", "expansion", "harrow", "wonder"]

    # Overall counts
    non_token = [c for c in cards if not c.get("is_token")]
    lines.append(f"**Total cards:** {len(cards)} ({len(non_token)} non-token)")
    lines.append("")

    # Per-set counts
    lines.append("## Cards Per Set")
    lines.append("| Set | Cards | Tokens | Total |")
    lines.append("|-----|-------|--------|-------|")
    for s in sets:
        set_cards = [c for c in cards if c.get("set") == s]
        tokens = [c for c in set_cards if c.get("is_token")]
        non = [c for c in set_cards if not c.get("is_token")]
        lines.append(f"| {s.title()} | {len(non)} | {len(tokens)} | {len(set_cards)} |")
    lines.append("")

    # Color distribution
    lines.append("## Color Identity Distribution")
    lines.append("| Color | Count | % |")
    lines.append("|-------|-------|---|")
    color_map = {"W": "White", "U": "Blue", "B": "Black", "R": "Red", "G": "Green"}
    dist = color_distribution(cards)
    total_colors = sum(dist.values())
    for key, count in dist.most_common():
        name = color_map.get(key, key)
        pct = count / total_colors * 100 if total_colors else 0
        lines.append(f"| {name} | {count} | {pct:.1f}% |")
    lines.append("")

    # Sentiment
    lines.append("## Sentiment Distribution")
    lines.append("| Set | Positive | Negative | Neutral |")
    lines.append("|-----|----------|----------|---------|")
    for s in sets:
        sent = sentiment_ratio(cards, s)
        total = sum(sent.values())
        if total:
            lines.append(
                f"| {s.title()} | {sent['positive']} ({sent['positive']/total*100:.0f}%) "
                f"| {sent['negative']} ({sent['negative']/total*100:.0f}%) "
                f"| {sent['neutral']} ({sent['neutral']/total*100:.0f}%) |"
            )
    lines.append("")

    # Type distribution
    lines.append("## Card Type Distribution")
    lines.append("| Type | Count |")
    lines.append("|------|-------|")
    for key, count in type_distribution(cards).most_common():
        lines.append(f"| {key} | {count} |")
    lines.append("")

    # Top keywords
    lines.append("## Top Keywords")
    lines.append("| Keyword | Count |")
    lines.append("|---------|-------|")
    for key, count in keyword_frequency(cards).most_common(20):
        lines.append(f"| {key} | {count} |")
    lines.append("")

    return "\n".join(lines)


def main():
    """Entry point."""
    parser = argparse.ArgumentParser(description="Card statistics from cards.json")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).parent.parent,
        help="Path to the repository root",
    )
    parser.add_argument(
        "--markdown",
        action="store_true",
        help="Output as markdown instead of terminal text",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Write output to file instead of stdout",
    )
    args = parser.parse_args()

    cards = load_cards(args.repo_root)
    non_token = [c for c in cards if not c.get("is_token")]

    if args.markdown:
        result = generate_markdown(cards)
        if args.output:
            args.output.write_text(result, encoding="utf-8")
            print(f"Report written to {args.output}")
        else:
            print(result)
        return

    # Terminal output
    print(f"=== Card Statistics ===")
    print(f"Total cards: {len(cards)} ({len(non_token)} non-token)")

    sets = ["original", "expansion", "harrow", "wonder"]
    for s in sets:
        count = sum(1 for c in cards if c.get("set") == s)
        print(f"  {s:12s}: {count} cards")

    print_counter("Color Identity (Overall)", color_distribution(cards))

    for s in sets:
        print_counter(f"Color Identity ({s.title()})", color_distribution(cards, s))

    print_counter("Card Types", type_distribution(cards))
    print_counter("Mana Curve (CMC)", mana_curve(cards))
    print_counter("Top Keywords", keyword_frequency(cards))

    print("\n### Sentiment by Set")
    for s in sets:
        sent = sentiment_ratio(cards, s)
        total = sum(sent.values())
        if total:
            print(
                f"  {s:12s}: "
                f"+{sent['positive']} ({sent['positive']/total*100:.0f}%) / "
                f"-{sent['negative']} ({sent['negative']/total*100:.0f}%) / "
                f"~{sent['neutral']} ({sent['neutral']/total*100:.0f}%)"
            )


if __name__ == "__main__":
    main()
