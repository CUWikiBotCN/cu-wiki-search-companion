#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

# Compatibility entrypoint for existing commands and local automation.
export CU_WIKI_PLAYWRIGHT_SESSION="${CU_WIKI_PLAYWRIGHT_SESSION:-cu_wiki_search_edge}"
exec bash "$(dirname "${BASH_SOURCE[0]}")/run-browser-playwright.sh" "$@"
