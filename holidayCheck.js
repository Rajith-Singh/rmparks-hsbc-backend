// holidayCheck.js
const axios = require('axios');
const holidayApiUrl = process.env.HOLIDAY_API_URL; // Ensure this is correctly defined in your .env file


// Checks if a given date is a holiday in both Sri Lanka and Maldives
async function isHoliday(date) {
  const formattedDate = date.toISOString().split("T")[0];
  const response = await axios.get(`YOUR_HOLIDAY_API_URL/${formattedDate}`);
  return {
    sriLankaHoliday: response.data.sriLanka === 'Y',
    maldivesHoliday: response.data.maldives === 'Y',
  };
}

// Finds the next working date by skipping holidays
async function getNextWorkingDate(startDate) {
  let date = new Date(startDate);
  while (true) {
    const holidayFlags = await isHoliday(date);
    if (holidayFlags.sriLankaHoliday && holidayFlags.maldivesHoliday) {
      date.setDate(date.getDate() + 1);
    } else {
      break;
    }
  }
  return date;
}

module.exports = { isHoliday, getNextWorkingDate };
