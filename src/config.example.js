// Configuration template - copy to src/config.js and edit (config.js is git-ignored)
export const config = {
  // Web login credentials (change these!)
  webUsername: 'admin',
  webPassword: 'changeme123',

  // Multiple Oracle databases (Thin mode)
  // The monitoring user on each DB should have SELECT on V$ views (or SELECT_CATALOG_ROLE)
  // and preferably ALTER SYSTEM privilege if you want the Kill Session feature.
  dbs: [
    {
      name: 'Primary',
      user: 'monitor_user',
      password: 'monitor_password',
      connectString: 'localhost:1521/FREEPDB1'
    },
    // Add more databases here:
    // {
    //   name: 'Standby',
    //   user: 'monitor_user',
    //   password: 'monitor_password',
    //   connectString: 'standby-host:1521/FREEPDB1'
    // }
  ],

  // App settings
  port: 3000,
  sessionSecret: 'change-this-to-a-long-random-string-in-production',
  refreshSeconds: 15
};
