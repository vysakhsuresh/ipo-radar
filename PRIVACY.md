# IPO Radar — Privacy Policy

_Last updated: 15 November 2026_

IPO Radar is an Android app (published by Layerbit) that shows information about Indian IPOs: dates, grey-market premium, subscription figures and a model's estimate of listing-day outcomes. This policy explains what the app does with information. The short version: **the app collects nothing about you.**

## What the app collects

Nothing. IPO Radar has no accounts, no sign-in, no analytics, no advertising, no crash-reporting service and no tracking of any kind. The developer receives no information about you, your phone or how you use the app.

## Network use

The app's only network activity is downloading public data files over HTTPS from GitHub (`raw.githubusercontent.com`), the same files anyone can read in the project's public repository:

- `data/scored.json` — the current IPO list and scores
- `model/params.json` — the model's parameters
- `data/history.json` — past listings used for calibration
- `data/track_record.json` — the model's past performance (when available)

These are plain downloads (HTTP GET). The app sends no identifiers, no settings and no personal data with them. As with any website, GitHub receives the network information needed to deliver a file (such as your IP address); GitHub's own privacy statement covers that: <https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement>.

Unencrypted (HTTP) connections are blocked by the app's network security configuration.

## What stays on your phone

Everything you set or enter stays on the device, in the app's private storage:

- your watchlist, alert switches, reminder time, refresh schedule and theme
- planner inputs and other page settings
- a cached copy of the downloaded data files

If you use Android's backup, your settings (not the cached data) may be included in your Google account backup or a device-to-device transfer, under Google's control and encryption. You can turn that off in Android settings. Uninstalling the app or clearing its storage deletes all of it.

## Notifications

All notifications are optional, off until you turn them on, and generated on your phone from the cached data (for example "last bidding day" for an IPO you watch). There is no push-notification server; nothing is sent to anyone to produce them.

## Sharing

When you tap Share, the app hands the text, file or image you chose to Android's share sheet. Where it goes next is up to you and the app you pick. Links (sources, help, support) open in your browser and are then governed by those websites' policies.

## Home-screen widget

The widget reads the same cached data on your phone. Its refresh button triggers the same public download described above.

## Children

The app is not directed at children and collects no data from anyone.

## Not investment advice

IPO Radar provides information and statistical estimates only. It does not offer trading, broking, lending or any financial service, and nothing in it is a recommendation to buy or sell securities.

## Changes and contact

If this policy changes, the new version will be published at this same address with a new date. Questions: email <ceo@layerbit.co.in> or open an issue at <https://github.com/vysakhsuresh/ipo-radar/issues>.
