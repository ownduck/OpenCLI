#!/bin/bash
# 一次性：@jackwener/opencli → @woosau/opencli，然后构建并发布到 npm
# 用法：sh deploy.sh

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
  --exclude=deploy.sh \
  '@jackwener/opencli' . | while IFS= read -r f; do
  sed -i 's|@jackwener/opencli|@woosau/opencli|g' "$f"
  echo "  $f"
done

echo "==> pnpm install"
pnpm install

echo "==> npm run build"
npm run build

echo "==> npm publish --access public"
npm publish --access public

echo "done: npm install -g @woosau/opencli"
