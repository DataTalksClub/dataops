import unittest
from dataops_secrets import SecretReader


class Clients:
    def get_item(self, **kwargs):
        assert kwargs['Key']['SK']['S'] == 'SECRET#allowed'
        assert kwargs['ConsistentRead'] is True
        return {'Item': {'data': {'S': 'Y2lwaGVy'}}}

    def decrypt(self, **kwargs):
        assert kwargs['EncryptionContext'] == {'secret': 'allowed'}
        assert kwargs['KeyId'] == 'fixture-key'
        return {'Plaintext': b'{"value":"fixture"}'}


class ReaderTest(unittest.TestCase):
    def test_read(self):
        client = Clients()
        reader = SecretReader(table_name='fixture', key_id='fixture-key',
                              region='eu-west-1', dynamodb=client, kms=client)
        self.assertEqual(reader.read('allowed'), {'value': 'fixture'})
        with self.assertRaises(ValueError):
            reader.read('invalid/name')


if __name__ == '__main__':
    unittest.main()
