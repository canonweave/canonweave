#!/bin/sh
# Run once after cloning. Activates the pre-push guard for the default branch.
git config core.hooksPath .githooks
echo "Pre-push guard active: direct pushes to the default branch are blocked. Branch + PR (CONTRIBUTING.md)."
