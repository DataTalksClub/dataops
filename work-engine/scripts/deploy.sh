#!/bin/bash
set -euo pipefail

LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:?'Set LAMBDA_FUNCTION_NAME'}"
AWS_REGION="${AWS_REGION:-us-east-1}"

echo "Installing production dependencies..."
npm ci --omit=dev

echo "Packaging..."
zip -r deployment.zip src/ node_modules/ package.json -x "*.test.*"

echo "Deploying to Lambda: ${LAMBDA_FUNCTION_NAME}..."
aws lambda update-function-code \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --zip-file fileb://deployment.zip \
  --region "$AWS_REGION"

echo "Cleaning up..."
rm -f deployment.zip
npm ci  # Restore dev deps

echo "Deploy complete!"
