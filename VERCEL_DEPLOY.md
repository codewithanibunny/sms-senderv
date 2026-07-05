# Vercel Deploy Notes

This project is now configured for Vercel with `api/index.py` and `vercel.json`.

## Environment Variables

Set these in Vercel Project Settings -> Environment Variables:

```text
SMS_LICENSE_KEY=your license key
SMS_FIREBASE_URL=your Firebase RTDB URL
SMS_FIREBASE_AUTH_KEY=your Firebase auth key
SMS_DEVICE_ID=your selected device id
SMS_SIM_SLOT=1
SMS_POLL_INTERVAL=2
```

## Deploy

From this folder:

```powershell
vercel
vercel --prod
```

## Important

Vercel is serverless, so the always-on local polling loop cannot run continuously there.
This app exposes `/api/poll-now` and `/api/cron` for request-based polling. The included
Vercel cron calls `/api/cron` every 5 minutes.
