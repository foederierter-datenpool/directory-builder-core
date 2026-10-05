#!/usr/bin/env bash
set -euo pipefail

# Nominatim's automatic cache sizing can exceed a container's RAM budget.
# Keep its arguments intact except for the node cache; --version passes through.
cache_mb=${OSM2PGSQL_CACHE_MB:-2048}
if [[ ! "$cache_mb" =~ ^[1-9][0-9]*$ ]]; then
    echo "OSM2PGSQL_CACHE_MB must be a positive integer (megabytes)" >&2
    exit 1
fi

args=()
while (( $# )); do
    case "$1" in
        --cache)
            if (( $# < 2 )); then
                echo "Missing osm2pgsql --cache argument" >&2
                exit 1
            fi
            args+=(--cache "$cache_mb")
            shift 2
            ;;
        --cache=*)
            args+=("--cache=$cache_mb")
            shift
            ;;
        *)
            args+=("$1")
            shift
            ;;
    esac
done
exec osm2pgsql "${args[@]}"
