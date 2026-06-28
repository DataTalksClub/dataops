#!/bin/bash
set -euo pipefail

LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:?'Set LAMBDA_FUNCTION_NAME'}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PACKAGE_DIR="${REPO_ROOT}/.tmp/work-engine-deploy"

echo "Installing production dependencies..."
cd "${REPO_ROOT}"
npm ci
npm run build:work-engine

echo "Packaging..."
rm -rf "${PACKAGE_DIR}"
mkdir -p "${PACKAGE_DIR}/work-engine"
cp -R work-engine/dist "${PACKAGE_DIR}/dist"
cp package.json package-lock.json "${PACKAGE_DIR}/"
cp work-engine/package.json "${PACKAGE_DIR}/work-engine/package.json"
(cd "${PACKAGE_DIR}" && npm ci --omit=dev --workspace dataops-work-engine)
(cd "${PACKAGE_DIR}" && zip -r deployment.zip dist/ node_modules/ package.json package-lock.json work-engine/package.json)

echo "Deploying to Lambda: ${LAMBDA_FUNCTION_NAME}..."
aws lambda update-function-code \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --zip-file "fileb://${PACKAGE_DIR}/deployment.zip" \
  --region "$AWS_REGION"

echo "Cleaning up..."
rm -rf "${PACKAGE_DIR}"

echo "Deploy complete!"
