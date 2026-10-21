'use strict';
// Fig's control panel: paste the bot token once, then Start / Stop / Restart, with the live log below.
// Run it as the thing your host keeps up (it listens on $PORT when the host sets one):
//   npm run panel
// Settings: FIG_PANEL_KEY (required unless it only listens on 127.0.0.1), PORT or FIG_PANEL_PORT,
// FIG_PANEL_HOST. See README "Control panel".
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
require('../src/web/panel').main();
