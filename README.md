# Kids Clothing Deal Finder

Daily deal checks for toddler clothing, with new verified deals delivered to Telegram.

## Criteria

- Retailers: Walmart, Target, Carter's, Old Navy, and The Children's Place (Amazon excluded).
- Sizes: 3T and 4T.
- Price: strictly less than $6 USD.
- Availability: the product page must expose structured product data showing an in-stock 3T/4T offer and its price. If the retailer page cannot be verified, the item is skipped.
- Notifications: only newly found qualifying product URLs; unchanged products are suppressed.
- Telegram alerts: 9:00 AM and 6:00 PM America/New_York.

## Required GitHub Actions secrets

The scheduled workflow runs in **GitHub Actions**, not as a Vercel function. Add these repository secrets in GitHub:

Repository → Settings → Secrets and variables → Actions → New repository secret

- `TAVILY_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Do not commit secrets or put them in source files. The existing Vercel environment variables are separate and are not automatically available to GitHub Actions.

## Schedule

The workflow checks four UTC trigger hours to cover both daylight-saving and standard time. The script checks the current `America/New_York` hour and only searches at 9 AM or 6 PM local time. GitHub scheduled workflows can start later than the requested minute.

## Deal history

`data/seen.json` stores product URLs already sent. The workflow commits updates to this file after successful Telegram delivery.

## Run manually

In GitHub, open Actions → Kids clothing deal finder → Run workflow. The script intentionally skips manual runs outside the two Eastern alert hours. To perform a test run, temporarily set `ALLOW_MANUAL_TEST=true` in the workflow environment and implement a test-only path before enabling it; do not use production Telegram secrets for unreviewed code.

## Limitations

Retailer pages differ. This first version relies on product-page JSON-LD structured data for price, size, and stock evidence. It favors avoiding false deal alerts over returning a large number of results; some genuine offers may be missed when a store does not publish structured variant data.
