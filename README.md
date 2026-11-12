# Duo Stock Watch

One page that answers one question: which Apple Store has an iPhone Duo for pickup right now.

It runs on your own computer. A small local server asks Apple's pickup endpoint every 15 seconds and
the page shows the result. Black screen means no stock. White screen means stock, with the
configuration, the store, and a link to buy.

## Run

Needs Node 20 or newer. No install step, no dependencies.

```bash
node server.mjs
```

Then open http://localhost:4173 in any browser.

Leave the terminal running. The server keeps checking even when the page is closed, and on macOS it
posts a system notification when stock appears.

## Use

- **Country**: pick from the dropdown. The choice is saved in `config.json` next to the server.
- **Postcode or city**: shown only for large countries, where Apple returns the stores nearest that place.
- **Alerts**: click once to turn on sound and browser notifications for the open page.

## How it works

Browsers refuse to read `apple.com` from another site's page, so the page cannot ask Apple itself.
`server.mjs` does it instead:

```
page  ->  http://localhost:4173/api/state  ->  server.mjs  ->  apple.com/<country>/shop/retail/pickup-message
```

The server sends one request for all eight configurations and reads `pickupDisplay` for each store.
The endpoint is unofficial. Apple can change or remove it at any time.

## Rate limits

Apple blocks networks that ask too often. A blocked request comes back as HTTP 541.

- The server never asks more than once every 5 seconds, and normally once every 15.
- After a block it waits 5, then 10, 20, and 30 minutes between tries.
- The page shows **Blocked** with a countdown while this is happening.

Running several copies, or switching country over and over, makes a block more likely.

## Status

- Singapore is the only country seen returning stock data, tested in a browser.
- Part numbers for the other 14 countries come from each country's buy page. Their stock calls and
  default postcodes are untested.
- The server's own requests to Apple have only been seen while the network was blocked, so a
  successful check from `server.mjs` is not yet confirmed.

## Files

- `server.mjs`: the checker and local web server
- `index.html`: the page
- `config.json`: your saved country and postcode, created on first change, not committed

Not affiliated with Apple.
