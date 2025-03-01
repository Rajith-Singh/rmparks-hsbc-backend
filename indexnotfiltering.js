const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const openpgp = require('openpgp');

dotenv.config();

const app = express();
const port = 3008;

// Load PGP keys from specified file paths
async function loadPGPKey(filePath) {
    try {
        const fullPath = `./encryption/${filePath}`;
        const key = await fs.readFile(fullPath, 'utf8');
        return key;
    } catch (error) {
        console.error(`Error loading PGP key from ${filePath}:`, error);
        throw error;
    }
}

// Sign and encrypt the payload with OpenPGP
async function signAndEncryptData(data, clientPrivateKeyArmored, hsbcPublicKeyArmored, passphrase) {
    const privateKey = await openpgp.decryptKey({
        privateKey: await openpgp.readPrivateKey({ armoredKey: clientPrivateKeyArmored }),
        passphrase,
    });
    const publicKey = await openpgp.readKey({ armoredKey: hsbcPublicKeyArmored });

    const message = await openpgp.createMessage({ text: data });
    const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: publicKey,
        signingKeys: privateKey,
    });

    return Buffer.from(encrypted).toString('base64');
}

// Use Flask server to decrypt data
async function decryptWithPython(encryptedData) {
    try {
        const decodedData = Buffer.from(encryptedData, 'base64').toString('utf-8');
        const response = await axios.post('http://localhost:5000/decrypt', {
            data: decodedData
        });
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}

// Fetch all transactions from HSBC without filtering
async function fetchAllTransactions() {
    const clientPrivateKey = await loadPGPKey('client-private.pem');
    const hsbcPublicKey = await loadPGPKey('hsbc-public.pem');
    const passphrase = '1password';

    // Get today's date and the date 30 days ago
    const today = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - 30); // Fetch transactions from last 30 days

    const formattedToday = today.toISOString().split('T')[0];  // e.g., 2025-03-01
    const formattedPastDate = pastDate.toISOString().split('T')[0];  // e.g., 2025-02-01

    const requestData = JSON.stringify({
        startDate: formattedPastDate,  // Default to last 30 days
        endDate: formattedToday,       // Up to today
        accountNumber: "339200000005",
        accountCountry: "GB",
    });

    const encryptedRequestData = await signAndEncryptData(requestData, clientPrivateKey, hsbcPublicKey, passphrase);
    const response = await axios.post(
        `${process.env.BANK_API_URL}/transactions`,
        { transactionsRequestBase64: encryptedRequestData },
        {
            headers: {
                'Content-Type': 'application/json',
                'x-hsbc-client-id': process.env.CLIENT_ID,
                'x-hsbc-client-secret': process.env.CLIENT_SECRET,
                'x-hsbc-profile-id': process.env.PROFILE_ID,
                'x-report-type': 'JSON',
                'x-sort-order': 'DESC',
            },
        }
    );

    const transactions = await decryptWithPython(response.data.reportBase64);
    return transactions;
}



// Route to get all transactions without filtering
app.get('/get-all-transactions', async (req, res) => {
    try {
        const transactionsData = await fetchAllTransactions();
        res.json(transactionsData);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to retrieve transactions due to server error.' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access all transactions at:`);
    console.log(`http://localhost:${port}/get-all-transactions`);
});
