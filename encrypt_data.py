# encrypt_data.py
import os
import pgpy
import sys
import base64

def load_key(file_path):
    """Load a PGP key from a file."""
    try:
        with open(file_path, 'r') as key_file:
            key_data = key_file.read()
        return pgpy.PGPKey.from_blob(key_data)[0]
    except Exception as e:
        print(f"Error loading key from {file_path}: {e}")
        sys.exit(1)

def sign_and_encrypt(data, private_key_path, public_key_path, passphrase):
    """Sign and encrypt data using a private key for signing and a public key for encryption."""
    try:
        # Load and unlock the private key with the passphrase
        private_key = load_key(private_key_path)
        private_key.unlock(passphrase)
        
        # Load the public key for encryption
        public_key = load_key(public_key_path)
        
        # Create a PGP message from the input data
        message = pgpy.PGPMessage.new(data)
        
        # Sign the message with the private key
        signed_message = private_key.sign(message)
        
        # Encrypt the signed message with the public key
        encrypted_message = public_key.encrypt(signed_message)
        
        # Return the encrypted message as a base64-encoded string
        return base64.b64encode(str(encrypted_message).encode('utf-8')).decode('utf-8')
    
    except Exception as e:
        print(f"Error during encryption: {e}")
        sys.exit(1)

if __name__ == "__main__":
    # Expecting data, private key path, public key path, and passphrase as command-line arguments
    if len(sys.argv) != 5:
        print("Usage: python encrypt_data.py <data> <private_key_path> <public_key_path> <passphrase>")
        sys.exit(1)

    data = sys.argv[1]
    private_key_path = sys.argv[2]
    public_key_path = sys.argv[3]
    passphrase = sys.argv[4]

    # Encrypt and print the result
    encrypted_data = sign_and_encrypt(data, private_key_path, public_key_path, passphrase)
    print(encrypted_data)
