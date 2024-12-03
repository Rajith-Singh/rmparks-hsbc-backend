const openpgp = require('openpgp');
const fs = require('fs').promises;
require('dotenv').config();

async function loadPGPKey(filePath) {
    const key = await fs.readFile(filePath, 'utf8');
    return key;
}

async function signAndEncryptPayload() {
    const payload = JSON.stringify({ valueDate: "2024-10-18" });

    // Load the PGP keys
    const clientPrivateKeyArmored = await loadPGPKey('./encryption/client-private.key');
    const hsbcPublicKeyArmored = await loadPGPKey('./encryption/hsbc-public.key');
    const passphrase = process.env.PGP_PASSPHRASE || ''; // Your private key passphrase if any

    // Decrypt the private key with the passphrase if necessary
    const clientPrivateKey = await openpgp.decryptKey({
        privateKey: await openpgp.readPrivateKey({ armoredKey: clientPrivateKeyArmored }),
        passphrase
    });
    const hsbcPublicKey = await openpgp.readKey({ armoredKey: hsbcPublicKeyArmored });

    // Encrypt and sign the payload
    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: payload }), // Message from payload
        encryptionKeys: hsbcPublicKey, // Encrypt with HSBC public key
        signingKeys: clientPrivateKey // Sign with your private key
    });

    // Convert the encrypted result to base64
    return Buffer.from(encrypted).toString('base64');
}

signAndEncryptPayload().then((base64Payload) => {
    console.log("Generated Base64 Payload:", base64Payload);
}).catch((error) => {
    console.error("Error generating payload:", error);
});
