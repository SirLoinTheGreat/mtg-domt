# The Deck of Many Things — MTG Crossover Project

![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)
![Cards: 148](https://img.shields.io/badge/Cards-148-gold)
![Last Updated: April 2026](https://img.shields.io/badge/Last%20Updated-April%202026-blue)

Welcome to a complete Magic: The Gathering crossover of D&D's infamous Deck of Many Things! This project reimagines one of tabletop gaming's most chaotic artifacts through the lens of Magic's mechanical framework.

## Overview

This collection features **148 custom cards** spread across four versions of the Deck:

| Set | Code | Cards | Source |
|-----|------|-------|--------|
| Original Deck | DOMT-OG | 22 + 5 support | D&D 5e DMG / Book of Many Things |
| Expansion Deck | DOMT-EX | 45 | Book of Many Things (2023) |
| Harrow Deck | DOMT-HW | 54 + 1 support | Pathfinder Harrow Deck |
| Wonder Deck | DOMT-WO | 22 | Deck of Wonder (2023) |

Each card has been carefully designed to maintain the spirit of its D&D counterpart while functioning within Magic's rules system. Where direct translation wasn't possible, we've created new interpretations that capture the original card's essence.

## Showcase

| | | |
|:---:|:---:|:---:|
| ![The Fates](assets/cards/original/The%20Fates.png) | ![Avatar of Death](assets/cards/original/The%20Skull%20(Avatar%20of%20Death).png) | ![The Moon](assets/cards/original/The%20Moon.png) |
| *The Fates — The Safety Valve* | *The Skull — Avatar of Death* | *The Moon — Three Wishes* |
| ![The Dragon](assets/cards/expansion/The%20Dragon.png) | ![The Paladin](assets/cards/harrow/The%20Paladin.png) | ![The Mute Hag](assets/cards/harrow/The%20Mute%20Hag.png) |
| *The Dragon — Five-Color Lord* | *The Paladin — Divine Champion* | *The Mute Hag — Sense Deprivation* |

## Features

- Complete rule system for integrating the Deck into any Commander game
- **Fate Point** mechanic for managing deck draws — risk vs. reward every turn
- 11 custom mechanics and status conditions unique to this set
- Optional rules for varied gameplay experiences (free first draw, multi-draw, d6 gambling)
- High-resolution card images (2010x2814) designed for printing with bleed margins
- Machine-readable card database (`data/cards.json`) with full card data
- Online gallery (`index.html`) with search, filtering, card detail view, and per-card changelog

## Using the Deck

The Deck of Many Things operates as a supplemental deck placed in the **command zone**. Players interact with it through the Fate Point system, choosing when to risk drawing from its chaos-inducing collection.

### Basic Rules

1. Shuffle the Deck and place it in the command zone
2. Each player begins with **1 Fate Point** (maximum 1)
3. From the starting player's **fifth turn** onward, spend a Fate Point during your precombat main phase to draw
4. Cards drawn are **cast immediately** without paying mana costs — they cannot be countered and don't use the stack
5. Only **The Fates** can respond to a Deck draw
6. Cards that would leave the battlefield are shuffled back into the Deck (except The Jester and The Fool, which exile)

Full rules: [Deck of Many Things Rules Card](assets/cards/original/Deck%20of%20Many%20Things%20Rules.png)

## Project Structure

```
mtg-domt/
├── README.md                 # This file
├── LICENSE                   # CC BY-NC-SA 4.0
├── index.html                # Online gallery (rollfor.gg/domt/)
├── assets/cards/
│   ├── original/             # Original Deck + support cards
│   │   └── thumbs/           # JPEG thumbnails for gallery
│   ├── expansion/            # Expansion Deck
│   ├── harrow/               # Harrow Deck + Plane of Air token
│   └── wonder/               # Wonder Deck
├── data/
│   ├── cards.json            # Machine-readable card database (148 cards)
│   └── card_history.json     # Per-card changelog for gallery
```

## How to Print

For quick physical copies:

1. Print card images on **110lb cardstock** (300gsm) at actual size — 9 cards per letter sheet
2. Cut along card borders
3. Sleeve each card with a **real MTG card behind it** for proper weight and shuffle feel
4. Use **opaque-backed sleeves** (Dragon Shield Matte, KMC Hyper Matte)

For professional prints, upload to [MakePlayingCards.com](https://www.makeplayingcards.com/) — select 63x88mm poker size, 330gsm smooth stock.

## Contributing

While this is primarily a personal project, suggestions and discussions are welcome through GitHub Issues.

## License

This is a fan-made crossover created under fair use for non-commercial purposes. Released under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License (CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/).

This project is not affiliated with, endorsed, or sponsored by Wizards of the Coast, Hasbro, or any of their subsidiaries. Magic: The Gathering and Dungeons & Dragons are trademarks of Wizards of the Coast LLC.

## Acknowledgments

- Card art generated with **MidJourney** (with one piece by **Christopher Lovell** for The Euryale)
- Card frames rendered via [Card Conjurer](https://cardconjurer.app/)
- Special thanks to the D&D and MTG communities for their inspiration and feedback

*"Sometimes the cards you're dealt become the fate you're given."*
