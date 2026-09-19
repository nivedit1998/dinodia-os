# Google Nest (Sandbox beta)

Dinodia OS can link one Google Nest account per hub through Google's official Smart Device Management (SDM) API. Version 1 publishes supported Nest thermostats as Dinodia OS heating devices; it does not pair hardware, import Google rooms, or replace Google Home.

## Operator setup

1. Create the Google Device Access Sandbox project and Web OAuth client in the team-owned Google account.
2. Enable the Smart Device Management API and request only `https://www.googleapis.com/auth/sdm.service`.
3. Add the exact Home 3 callback to the OAuth client and Device Access project:
   `https://hub-001.dinodiasmartliving.com/_dinodia/oauth/google-nest/callback`
4. Open the secure Home 3 dashboard at \`https://hub-001.dinodiasmartliving.com/\`, select **Pair a device → Google Nest**, enter:
   - **Device Access project ID** — the UUID from the Device Access Console;
   - **OAuth client ID** — the Web application client ID ending in \`.apps.googleusercontent.com\`;
   - **OAuth client secret** — enter it directly into the password field.

   Select **Save encrypted credentials**. Dinodia OS submits these values only over the secure Cloudflare dashboard and stores them in the Pi's encrypted vault. The client secret is never returned to the browser, status API, activity log, heartbeat, diagnostics, or support bundle.

   The terminal setup remains available as a recovery/operator fallback while the service is stopped:

   ```bash
   sudo systemctl stop dinodia-os
   sudo -u dinodia DINODIA_DATA_DIR=/var/lib/dinodia-os CLOUDFLARE_PUBLIC_HOSTNAME=hub-001.dinodiasmartliving.com node /opt/dinodia-os/scripts/configure-google-nest.js
   sudo systemctl start dinodia-os
   ```

The script is interactive and does not accept the client secret as a command-line argument. The secret and customer refresh token are stored only in the encrypted vault. They are not in `.env`, the dashboard, activity, heartbeat, or diagnostics.

## Customer flow

In **Pair a device → Google Nest**, choose **Connect Google Nest account**. Google sign-in and consent open in a normal browser tab. After consent, supported thermostats appear as `Needs setup`. Assign the existing Dinodia area, keep or edit the friendly name, and select `Boiler`. Google room names are hints only and never create Dinodia areas.

The integration refreshes short-lived access tokens automatically and polls the account once per minute with jitter. A revoked or expired authorization shows **Action needed** and stops writes until the owner reconnects.

## Supported controls

- current temperature;
- target heating temperature;
- advertised heat/off mode;
- active heating/idle/off state;
- online/offline state;
- humidity as a diagnostic value.

Nest schedules, hot-water controls, boiler fault codes, efficiency, gas consumption, cameras, doorbells, audio, video, and media are not published. Removing a device from Dinodia OS hides it locally and does not delete it from Google Home. Disconnecting the account revokes access where possible and removes only local Nest data.

## Release limitation

This is a controlled Sandbox beta. Google currently gates commercial Device Access applications and Sandbox/testing credentials can have shorter refresh-token lifetimes. Do not enable broad customer rollout until Google approval, OAuth verification, and a central OAuth broker remove the pilot client-secret-on-hub risk.
