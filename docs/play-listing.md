# Google Play listing — draft

Package: `com.layerbit.iporadar` · versionName 1.0.0 (versionCode 2) · min Android 8.0 (API 26), target API 36.

## App name

IPO Radar

## Short description (≤ 80 characters)

```
Indian IPO dates, GMP, subscription and listing-gain odds. Not advice.
```
(70 characters)

## Full description (≤ 4000 characters)

```
IPO Radar lists every Indian IPO in the pipeline, mainboard and SME, and puts the numbers you would otherwise gather from several websites on one screen.

For each issue it shows:
• Bidding, allotment and listing dates
• The grey market premium (GMP) and how it has moved
• Subscription by category (retail, HNI, QIB) as it comes in
• An estimated chance that the share closes above its issue price on listing day
• A likely gain range (a low, middle and high case, not a single number)
• Your odds of being allotted shares under the retail lottery
• What one application is worth after brokerage, taxes, exchange and DP charges
• A plain verdict: Apply, Lean apply, Coin flip, Avoid or Too early, with the warnings behind it

How the estimates work
The model combines the grey market premium with subscription figures, issue size, board and market conditions. Until enough past listings are available to calibrate it, the app says so plainly. When it is calibrated, it reports how well its past predictions held up. Grey market quotes are unofficial and thin for small issues; the app treats them as one input, not the answer.

Planner
A planner answers a common question: how much capital, and how many applications, would listing gains need to reach a monthly target? It shows the arithmetic, including the months that bring no allotment at all.

Watchlist and alerts (optional)
Watch the IPOs you care about and, if you want, get a notification when bidding opens, on the last bidding day, on allotment day, the day before listing, or when the verdict changes. Alerts are off until you turn them on and are worked out on your phone.

Home-screen widget
See how many IPOs are open, the next three with their verdicts and closing dates, and how fresh the data is.

Works offline
A snapshot of the data ships inside the app. When you are online it downloads the latest public data files, refreshed several times each trading day.

Private by design
No account, no ads, no analytics, no tracking. The app only downloads public data files; your watchlist and settings never leave your phone.

Important
IPO Radar provides information and statistical estimates only. It is not investment advice and not a recommendation to apply for, buy or sell any security. It does not offer trading, broking, loans or any financial service, and it is not affiliated with SEBI, NSE, BSE or any broker. Estimates can be wrong; a listing-day market shock is in nobody's numbers. Check the offer document and consult a SEBI-registered adviser before investing.
```

## Category and tags

- **Category:** Finance
- **Tags (pick up to 5):** Stocks & trading information, Investing, Finance news, Market data

## Contact details

- Website: the project's GitHub page
- Email: (developer account email)
- Privacy policy URL: host `PRIVACY.md` (e.g. GitHub Pages or the raw GitHub view of the file) and paste the public URL.

## Data safety form

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| Is all of the user data collected by your app encrypted in transit? | Not applicable (no user data collected). All network traffic is HTTPS; cleartext is blocked. |
| Do you provide a way for users to request that their data is deleted? | Not applicable (nothing is collected; uninstalling or clearing storage removes all on-device data). |
| Data shared with third parties | None |
| Account creation | None |

Notes for the reviewer: the app downloads public JSON files from `raw.githubusercontent.com` with plain GET requests that carry no identifiers. Watchlist, alert settings and planner inputs stay in app-private storage on the device. Notifications are generated locally by WorkManager jobs; there is no push service, analytics SDK or ads SDK.

## Content rating (IARC questionnaire)

- Category: **Utility, productivity, communication or other** (reference / information app)
- Violence, sexual content, profanity, drugs, gambling: **No** to all
- Simulated gambling: **No** (the app shows statistical estimates for real IPOs; it involves no wagering, currency or rewards)
- User-generated content / user interaction / sharing location: **No**
- Purchases / digital goods: **No**
- Expected rating: Everyone / PEGI 3 / IARC 3+

## Financial features declaration

Play Console → App content → Financial features:

- Select **"My app doesn't provide any financial features"**, or, if the form requires a choice for information apps, the closest option describing *financial information / stock market data*.
- The app **does not** offer: personal loans, earned-wage access, banking, payments, crypto, trading or brokerage, insurance, or investment advisory services.
- It **only displays information** (public IPO data and model estimates) with a clear "not investment advice" notice on the listing and in the app.

## Ads

Contains ads: **No**.

## Target audience

18 and over (finance information). Not designed for children.

## Permissions to explain if asked

| Permission | Why |
|---|---|
| INTERNET, ACCESS_NETWORK_STATE | Download the public data files; show an offline badge; run background refresh only when online |
| POST_NOTIFICATIONS | Optional watchlist / verdict / new-data alerts, asked only when the person turns one on |
| RECEIVE_BOOT_COMPLETED, WAKE_LOCK (added by WorkManager) | Keep the person's chosen refresh / reminder schedule across reboots |

## Release checklist

1. Create `keystore.properties` (storeFile, storePassword, keyAlias, keyPassword) next to `settings.gradle.kts`; never commit it.
2. `./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`.
3. Enrol in Play App Signing; upload the AAB.
4. Upload `app/build/outputs/mapping/release/mapping.txt` if Play does not pick it up from the bundle.
5. Screenshots: list view (light), an IPO detail sheet, the planner, dark mode, and the widget on a home screen.
