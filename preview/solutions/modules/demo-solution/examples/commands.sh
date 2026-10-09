#!/usr/bin/env bash
# The commands this fixture's step page shows, single-sourced the way a real
# solution does it: the page includes a tag region, never a literal command.

# tag::up[]
docker compose up -d --wait
# end::up[]

# tag::info[]
rpk cluster info
# end::info[]
