#!/bin/bash
# Push Qleno to GitHub
# Usage: bash push-to-github.sh "your commit message"

MSG="${1:-light theme, discounts, dispatch board, geo-clock system}"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "ERROR: GITHUB_PERSONAL_ACCESS_TOKEN secret is not set."
  exit 1
fi

echo "Configuring remote..."
git remote set-url github "https://${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/salmartinez-design/qleno.git" 2>/dev/null || \
  git remote add github "https://${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/salmartinez-design/qleno.git"

echo "Staging all changes..."
git add -A

echo "Committing: $MSG"
git commit -m "$MSG" --allow-empty

echo "Pushing to GitHub..."
git push github HEAD:main --force-with-lease

echo "Done! Check: https://github.com/salmartinez-design/qleno"
