#!/bin/bash
# 仅换名（Git Bash）：@jackwener/opencli → @woosau/opencli
# 用法：sh deploy-rename.sh

cd "$(dirname "$0")"

echo "==> rename @jackwener/opencli -> @woosau/opencli"
grep -rl \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=coverage \
  --exclude-dir=.vitepress \
  --exclude-dir=.cache \
  --exclude-dir=.turbo \
  --exclude=deploy-rename.sh \
  --exclude=deploy.cmd \
  '@jackwener/opencli' . | while IFS= read -r f; do
  sed -i 's|@jackwener/opencli|@woosau/opencli|g' "$f"
  echo "  $f"
done

echo "rename done."
echo "next (cmd/PowerShell): deploy.cmd"
echo "  or with OTP: deploy.cmd 123456"
