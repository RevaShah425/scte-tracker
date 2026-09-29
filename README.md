# scte-tracker

A web dashboard for tracking SCTE-35 messages during NBA games using data from a Bridge Technologies VB330 probe.

## Initial scope

- Track NBA TV’s NBAM feed scte count to align with requirements for compliance. 
- Count every SCTE message reported by the probe during a game’s tracking window.
- Display progress toward 96 messages per game, which can later be configured to different numbers for different feed requirements. 
- Provide Start Tracking, Refresh, and End Tracking controls.
- Show the last successful data update.
- Save event history without counting the same event again on each refresh.
- Preserve raw event details for future analysis.

## Design
A TV-inspired dashboard with a 96-square progress graphic:
one filled square per counted message. Counts can exceed the target.

## How it works
1. A backend collector requests SCTE-35 events from the probe’s Eii interface.
2. A database stores events and game tracking windows.
3. The dashboard requests the current game count from the backend.
4. Refresh updates the display without rebuilding the website.
   
Postman is used to test requests, not to supply data to the finished app.

## Deployment
Development starts locally on a computer with access to the probe’s network.

Production requires an always-on backend with network access to the probe.
GitHub stores the source code. GitHub Pages alone cannot run the collector or database.

## Credentials

Keep probe credentials on the backend using environment variables or a secret store.
Never commit passwords, authentication headers, or local .env files.
Never include probe credentials in browser code.

## Future improvements

- Automatic refresh - animated live updates - but would potentially require heavy java+3rd party in the background
- Additional feeds beyond NBAtv.com configurable targets
- SCTE message classification
- Game history, reports, and event analysis

## Status

API access has been tested successfully in Postman - so data retrieval is confirmed.
Dashboard, collector, database, and deployment are under development. 


## Prototype Image
