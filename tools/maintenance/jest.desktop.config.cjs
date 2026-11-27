const { desktopProjects, jestConfig } = require("./verification-projects.cjs");
module.exports = jestConfig(desktopProjects);
