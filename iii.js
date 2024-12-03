const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { exec } = require('child_process');
const dotenv = require('dotenv');
const openpgp = require('openpgp');
const sql = require('mssql');
const { format, parseISO, addDays } = require('date-fns');

dotenv.config();

const app = express();
const port = 3004;

// SQL Configuration assumed to be set in your .env file or directly here
const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

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

    // Return the encrypted data as a base64 encoded string
    return Buffer.from(encrypted).toString('base64');
}

// Use Flask server to decrypt data
async function decryptWithPython(encryptedData) {
    try {
        const decodedData = Buffer.from(encryptedData, 'base64').toString('utf-8');
        const response = await axios.post('http://localhost:5000/decrypt', { data: decodedData });
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}

// Function to determine if a date is a weekend or holiday
async function isHolidayOrWeekend(date, country) {
    const weekendDays = country === 'MV' ? [5, 6] : [6, 0];
    if (weekendDays.includes(date.getDay())) return true;

    const formattedDate = format(date, 'yyyy-MM-dd');
    const response = await axios.get(`https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${country}&year=${date.getFullYear()}&month=${date.getMonth() + 1}&day=${date.getDate()}`);
    return response.data.response.holidays.length > 0;
}

// Calculate the next business day, considering holidays and weekends
async function getNextBusinessDay(date) {
    let currentDate = date;
    do {
        currentDate = addDays(currentDate, 1);
    } while (await isHolidayOrWeekend(currentDate, 'LK') || await isHolidayOrWeekend(currentDate, 'MV'));
    return currentDate;
}

// Fetch transactions from HSBC with signing and encryption
async function fetchTransactions(transactionDate) {
    const date = parseISO(transactionDate);
    const isHolidayLK = await isHolidayOrWeekend(date, 'LK');
    const isHolidayMV = await isHolidayOrWeekend(date, 'MV');
    const effectiveDate = isHolidayLK || isHolidayMV ? await getNextBusinessDay(date) : date;
    const formattedDate = format(effectiveDate, 'yyyy-MM-dd');

    const clientPrivateKey = await loadPGPKey('client-private.pem');
    const hsbcPublicKey = await loadPGPKey('hsbc-public.pem');
    const passphrase = '1password';

    const requestData = JSON.stringify({
        transactionDate: formattedDate,
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

app.get('/get-all-transactions', async (req, res) => {
    const transactionDate = req.query.date;
    if (!transactionDate) {
        return res.status(400).json({ error: "Missing 'date' query parameter in YYYY-MM-DD format." });
    }

    try {
        const transactionsData = await fetchTransactions(transactionDate);
        res.json(transactionsData);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to retrieve transactions due to server error.' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the transaction fetch API with a date filter at: http://localhost:${port}/get-all-transactions?date=YYYY-MM-DD`);
});
