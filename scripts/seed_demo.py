#!/usr/bin/env python3
"""Populate an empty installation with fictional records for a product demo."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from catalogue_store import load_records, save_records  # noqa: E402

SAMPLES = [
    ("The Harbour Clock", "A watchmaker traces the source of a town's missing hour.", ["Mystery", "Coastal"]),
    ("The Salt Road", "Two siblings carry a disputed map across a drought-struck plain.", ["Adventure", "Family"]),
    ("A House of Moths", "An archivist finds letters hidden inside the walls of an abandoned house.", ["Mystery", "Literary"]),
    ("Before the Floodlights", "A goalkeeper returns to her hometown for one last season.", ["Sports", "Contemporary"]),
    ("Orchard in Winter", "A grower inherits an orchard and a ledger of unexplained harvests.", ["Literary", "Family"]),
    ("The Glass Observatory", "An apprentice astronomer challenges the forecasts that govern her city.", ["Science Fiction", "Adventure"]),
    ("Seven Stops North", "Strangers on a delayed train unravel a message meant for one of them.", ["Mystery", "Contemporary"]),
    ("A Map of Rain", "A hydrologist searches for a vanished river and the village built beside it.", ["Adventure", "Environment"]),
    ("The Paper Bridge", "A student restores a damaged bridge from plans no one remembers drawing.", ["Contemporary", "Community"]),
    ("Night Market Radio", "A late-night broadcaster receives calls describing tomorrow's market.", ["Speculative", "Mystery"]),
    ("A Small Season", "Three neighbours rebuild a greenhouse after the town's final nursery closes.", ["Slice of Life", "Community"]),
    ("Signal at the Edge", "A remote research crew must decide whether a repeating signal is a warning.", ["Science Fiction", "Mystery"]),
    ("The Copper Atlas", "A surveyor follows a changing atlas through several disputed borders.", ["Fantasy", "Adventure"]),
    ("Letters to the Tides", "A marine biologist answers notes left in bottles along an empty shore.", ["Contemporary", "Romance"]),
    ("The Third Bell", "A young bellmaker investigates why one tower rings without a bell.", ["Fantasy", "Mystery"]),
    ("Under Cedar Light", "A forest ranger documents unfamiliar tracks before a road reaches the valley.", ["Environment", "Adventure"]),
    ("The Quiet Tournament", "A retired player mentors a team competing in a game she helped invent.", ["Sports", "Community"]),
    ("Where the Snow Ends", "Two climbers take different routes toward the same weather station.", ["Adventure", "Survival"]),
    ("The Museum of Keys", "A locksmith sorts a museum's unlabeled keys and finds a door left off every plan.", ["Mystery", "Fantasy"]),
    ("Tomorrow's Postmark", "A postal worker discovers one undeliverable letter arrives each morning.", ["Speculative", "Contemporary"]),
    ("The Last Seedkeeper", "An apprentice preserves a rare seed collection through a changing climate.", ["Environment", "Science Fiction"]),
    ("A City of Stairs", "A courier searches a vertical city for the architect who drew its missing levels.", ["Fantasy", "Adventure"]),
    ("Between Two Stations", "Former friends meet again while repairing a closed railway station.", ["Contemporary", "Friendship"]),
    ("The Blue Workshop", "A craftswoman opens a workshop where every commission comes with a secret.", ["Slice of Life", "Mystery"]),
    ("The Lantern Survey", "A night-shift engineer maps lights that appear beyond the city's power grid.", ["Science Fiction", "Mystery"]),
    ("A Name for the Windmill", "A village argues over a new windmill while a child records each side's story.", ["Literary", "Community"]),
    ("The Iron Orchard", "An inventor returns to a garden of machines that no longer obey their schedule.", ["Science Fiction", "Family"]),
    ("The River Census", "A census worker finds more households along the river than the maps allow.", ["Mystery", "Environment"]),
    ("The Summer Archive", "A librarian assembles a town's lost summer from borrowed photographs.", ["Literary", "Contemporary"]),
    ("Far Side of the Garden", "Two neighbours exchange notes over a wall they have never crossed.", ["Romance", "Slice of Life"]),
]


def seed_demo() -> int:
    if load_records():
        raise ValueError("The catalogue is not empty; demonstration records were not added")
    records = [
        {
            "id": number,
            "title": title,
            "title_aliases": [],
            "author": "",
            "synopsis": premise,
            "tags": tags,
            "source": "NoveList fictional demonstration",
            "status": "Fictional sample",
            "cover_url": "",
            "urls": [],
            "hand_authored": False,
        }
        for number, (title, premise, tags) in enumerate(SAMPLES, 1)
    ]
    save_records(records)
    return len(records)


if __name__ == "__main__":
    try:
        print(f"Added {seed_demo()} fictional demonstration records. Run make index next.")
    except ValueError as error:
        raise SystemExit(str(error)) from error
