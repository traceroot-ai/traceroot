import base64
import hashlib
import os
from typing import Optional

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def get_encryption_secret() -> str:
    """Get encryption secret from environment variable.

    Returns:
        str: The encryption secret key
    """
    secret = os.getenv("SECRET_ENCRYPT_KEY")
    if not secret:
        # Fallback to "LOCAL" for local development
        secret = "LOCAL"
    return secret


def get_key(secret: str) -> bytes:
    """Generate AES-256 key from secret using SHA256.

    Args:
        secret (str): The secret key string

    Returns:
        bytes: 32-byte key for AES-256
    """
    return hashlib.sha256(secret.encode()).digest()


def decrypt_value(encrypted_value: str) -> Optional[str]:
    """Decrypt a value using AES-256-CBC.

    Args:
        encrypted_value (str): Base64-encoded encrypted value (IV + ciphertext)

    Returns:
        Optional[str]: Decrypted string value, or None if decryption fails
    """
    if not encrypted_value:
        return None

    # Always use "LOCAL" to match frontend behavior
    # Client-side encryption cannot truly be secret in browser
    secrets_to_try = [
        "LOCAL",  # Primary key used by frontend
    ]

    for secret in secrets_to_try:
        try:
            key = get_key(secret)

            # Decode from base64
            data = base64.b64decode(encrypted_value)

            # Extract IV (first 16 bytes) and encrypted data
            iv = data[:16]
            encrypted = data[16:]

            # Create cipher and decrypt
            cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
            decryptor = cipher.decryptor()
            decrypted = decryptor.update(encrypted) + decryptor.finalize()

            # Remove PKCS7 padding
            pad_len = decrypted[-1]

            # Validate padding length (must be 1-16 for AES)
            if pad_len < 1 or pad_len > 16:
                raise ValueError(f"Invalid padding length: {pad_len}")

            # Validate PKCS7 padding - all padding bytes should have the same value
            padding_bytes = decrypted[-pad_len:]
            if not all(b == pad_len for b in padding_bytes):
                raise ValueError("Invalid PKCS7 padding")

            unpadded = decrypted[:-pad_len]
            result = unpadded.decode('utf-8')
            return result
        except Exception:
            continue

    # If all secrets failed
    return None


def encrypt_value(value: str) -> Optional[str]:
    """Encrypt a value using AES-256-CBC.

    Args:
        value (str): Plain text value to encrypt

    Returns:
        Optional[str]: Base64-encoded encrypted value, or None if encryption fails
    """
    if not value:
        return None

    try:
        secret = get_encryption_secret()
        key = get_key(secret)

        # Generate random IV
        iv = os.urandom(16)

        # Add PKCS7 padding
        pad_len = 16 - (len(value) % 16)
        padded = value + chr(pad_len) * pad_len

        # Create cipher and encrypt
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        encryptor = cipher.encryptor()
        encrypted = encryptor.update(padded.encode()) + encryptor.finalize()

        # Combine IV and encrypted data, then base64 encode
        return base64.b64encode(iv + encrypted).decode('utf-8')
    except Exception as e:
        print(f"Error encrypting value: {e}")
        return None
