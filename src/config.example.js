// Configuration template - copy to src/config.js and edit (config.js is git-ignored)
export const config = {
  // Database login page:
  //   'yes' → the first page asks for database credentials (username, password,
  //           Normal/SYSDBA/SYSOPER, connection string). They are kept only in server
  //           memory for the current browser session and never saved. `dbs` is ignored.
  //   'no'  → credentials are taken from `dbs` below.
  databaseLoginPage: 'no',

  // Login-page mode: forget the credentials after this many idle minutes
  sessionIdleMinutes: 30,

  // Multiple Oracle databases (Thin mode) - used when databaseLoginPage is 'no'
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
  refreshSeconds: 15
};
