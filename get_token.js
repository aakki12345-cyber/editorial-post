const { google } = require('googleapis');
const readline = require('readline');
require('dotenv').config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('=============================================');
console.log('Which token are you trying to generate?');
console.log('1. Blogger (Select your Blogger Gmail ID)');
console.log('2. Google Drive (Select your Drive Gmail ID)');
console.log('=============================================');

rl.question('Enter 1 or 2: ', (choice) => {
  let CLIENT_ID, CLIENT_SECRET, SCOPES, TOKEN_NAME;

  if (choice === '1') {
    CLIENT_ID = process.env.BLOGGER_CLIENT_ID;
    CLIENT_SECRET = process.env.BLOGGER_CLIENT_SECRET;
    SCOPES = ['https://www.googleapis.com/auth/blogger'];
    TOKEN_NAME = 'BLOGGER_REFRESH_TOKEN';
  } else if (choice === '2') {
    CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
    CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    SCOPES = ['https://www.googleapis.com/auth/drive.file'];
    TOKEN_NAME = 'GOOGLE_DRIVE_REFRESH_TOKEN';
  } else {
    console.error('❌ Invalid choice. Exiting.');
    process.exit(1);
  }

  // Validate the keys
  if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_ID.includes('your_')) {
    console.error(`\n❌ ERROR: Your ${TOKEN_NAME.replace('REFRESH_TOKEN', 'CLIENT_ID')} is missing or invalid in your .env file.`);
    console.error(`Please go to the Google Cloud Console, generate OAuth Credentials, and update your .env file first.`);
    process.exit(1);
  }

  const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: SCOPES,
  });

  console.log('\n=============================================');
  console.log('🔗 1. Go to this URL in your browser:');
  console.log(`(When prompted, select the Gmail account you use for ${choice === '1' ? 'Blogger' : 'Google Drive'})`);
  console.log('\n', authUrl, '\n');
  console.log('=============================================');
  console.log('⚠️  After you authorize the app, it will redirect you to a page that looks broken (http://localhost:3000/oauth2callback...).');
  console.log('📋 2. Copy the ENTIRE URL you were redirected to and paste it below.');
  console.log('=============================================\n');

  rl.question('Paste the full redirected URL here: ', async (url) => {
    try {
      const urlObj = new URL(url);
      const code = urlObj.searchParams.get('code');

      if (!code) {
        console.error('❌ Could not find "code=" in the URL.');
        process.exit(1);
      }

      const { tokens } = await oauth2Client.getToken(code);
      
      console.log('\n✅ SUCCESS! Here is your token:\n');
      console.log('---------------------------------------------');
      console.log(`${TOKEN_NAME}=${tokens.refresh_token}`);
      console.log('---------------------------------------------');
      
      if (tokens.refresh_token) {
        console.log(`\n➡️ Copy the token above and save it to your .env file as ${TOKEN_NAME}.\n`);
      } else {
        console.error('\n❌ No refresh token was returned. Make sure you haven\'t authorized this app previously without revoking it, and that prompt="consent" is set.');
      }
    } catch (error) {
      console.error('❌ Error getting tokens:', error.response?.data || error.message);
    } finally {
      rl.close();
    }
  });
});
