const { legacyProjects, jestConfig } = require("./verification-projects.cjs");
module.exports = jestConfig(legacyProjects);
