const crypto = require('crypto');
const fs = require('fs');

// Load keys from files
const clientPrivateKey = fs.readFileSync('client-private.key', 'utf8');
const hsbcPublicKey = fs.readFileSync('hsbc-public.key', 'utf8');

// Function to encrypt data with the bank's public key
function encryptData(data) {
    const buffer = Buffer.from(data);
    const encrypted = crypto.publicEncrypt(
        {
            key: hsbcPublicKey,
            padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        buffer
    );
    return encrypted.toString('base64'); // Return Base64 string for easy use in Postman
}

// Function to decrypt data with your private key
function decryptData(encryptedData) {
    const buffer = Buffer.from(encryptedData, 'base64');
    const decrypted = crypto.privateDecrypt(
        {
            key: clientPrivateKey,
            passphrase: '', // Add passphrase if your private key requires one
            padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        buffer
    );
    return decrypted.toString('utf8');
}

// Example usage

// Step 1: Encrypt your request data
const requestData = JSON.stringify({ valueDate: '2024-10-18' }); // Replace with your actual request data
const encryptedData = encryptData(requestData);
console.log('Encrypted Request Data:', encryptedData);

// Step 2: Simulate decrypting a response from the bank (example only)
const decryptedData = decryptData(encryptedData); // Replace encryptedData with actual response when using
console.log('Decrypted Response Data:', decryptedData);
