/**
 * Navigation hooks. app.js fills these in at start-up; views call them without importing the
 * router (which imports the views), so there is no import cycle.
 */
export const nav = {
  go: (path) => {},                                // change page
  openRecord: (object, id, list) => {},            // open a record (panel or page, per Settings)
  closeRecord: () => {},
  create: (object, defaults) => {},                // open the create modal
  current: () => ({}),                             // the current route
};
