"""Minimal DataOps machine reader. Requires boto3; never logs secret values."""
import base64
import json
import re


class SecretReader:
    def __init__(self, *, table_name, key_id, region, dynamodb=None, kms=None):
        if not table_name or not key_id or not region:
            raise ValueError("Secret reader requires table_name, key_id and region")
        if dynamodb is None or kms is None:
            import boto3
            dynamodb = dynamodb or boto3.client("dynamodb", region_name=region)
            kms = kms or boto3.client("kms", region_name=region)
        self.table_name, self.key_id = table_name, key_id
        self.dynamodb, self.kms = dynamodb, kms

    def read(self, name):
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", name):
            raise ValueError("Invalid secret name")
        item = self.dynamodb.get_item(
            TableName=self.table_name,
            Key={"PK": {"S": "SECRETS"}, "SK": {"S": "SECRET#" + name}},
            ConsistentRead=True, ProjectionExpression="#data",
            ExpressionAttributeNames={"#data": "data"},
        ).get("Item", {})
        ciphertext = item.get("data", {}).get("S")
        if not ciphertext:
            raise ValueError("Secret does not exist or has no ciphertext: " + name)
        response = self.kms.decrypt(
            KeyId=self.key_id, CiphertextBlob=base64.b64decode(ciphertext, validate=True),
            EncryptionContext={"secret": name},
        )
        fields = json.loads(response["Plaintext"].decode("utf-8"))
        if not isinstance(fields, dict) or any(not isinstance(v, str) for v in fields.values()):
            raise ValueError("Secret payload fields must be strings")
        return fields
