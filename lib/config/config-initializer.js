/**
 * @fileoverview Config initialization wizard.
 * @author Ilya Volodin
 * @copyright 2015 Ilya Volodin. All rights reserved.
 */

"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

var util = require("util"),
    debug = require("debug"),
    lodash = require("lodash"),
    inquirer = require("inquirer"),
    ProgressBar = require("progress"),
    autoconfig = require("./autoconfig.js"),
    ConfigFile = require("./config-file"),
    getSourceCodeOfFiles = require("../util/source-code-util").getSourceCodeOfFiles,
    npmUtil = require("../util/npm-util"),
    recConfig = require("../../conf/eslint.json"),
    log = require("../logging");

debug = debug("eslint:config-initializer");

//------------------------------------------------------------------------------
// Private
//------------------------------------------------------------------------------

/* istanbul ignore next: hard to test fs function */
/**
 * Create .eslintrc file in the current working directory
 * @param {Object} config object that contains user's answers
 * @param {string} format The file format to write to.
 * @param {function} callback function to call once the file is written.
 * @returns {void}
 */
function writeFile(config, format, callback) {

    // default is .js
    var extname = ".js";
    if (format === "YAML") {
        extname = ".yml";
    } else if (format === "JSON") {
        extname = ".json";
    }


    try {
        ConfigFile.write(config, "./.eslintrc" + extname);
        log.info("Successfully created .eslintrc" + extname + " file in " + process.cwd());
    } catch (e) {
        callback(e);
        return;
    }

    callback();
}

/**
 * Synchronously install necessary plugins, configs, parsers, etc. based on the config
 * @param   {Object} config  config object
 * @returns {void}
 */
function installModules(config) {
    var modules = [],
        installStatus,
        modulesToInstall;

    // Create a list of modules which should be installed based on config
    if (config.plugins) {
        modules = modules.concat(config.plugins.map(function(name) {
            return "eslint-plugin-" + name;
        }));
    }
    if (config.extends && config.extends.indexOf("eslint:") === -1) {
        modules.push("eslint-config-" + config.extends);
    }

    // Determine which modules are already installed
    if (modules.length === 0) {
        return;
    }
    installStatus = npmUtil.checkDevDeps(modules);

    // Install packages which aren't already installed
    modulesToInstall = Object.keys(installStatus).filter(function(module) {
        return installStatus[module] === false;
    });
    if (modulesToInstall.length > 0) {
        log.info("Installing " + modulesToInstall.join(", "));
        npmUtil.installSyncSaveDev(modulesToInstall);
    }
}

/**
 * Set the `rules` of a config by examining a user's source code
 *
 * Note: This clones the config object and returns a new config to avoid mutating
 * the original config parameter.
 *
 * @param   {Object} answers  answers received from inquirer
 * @param   {Object} config   config object
 * @param   {Object} callback function to call with any erorrs.
 * @returns {Object}          config object with configured rules
 */
function configureRules(answers, config, callback) {
    var BAR_TOTAL = 20,
        BAR_SOURCE_CODE_TOTAL = 4;

    var newConfig = lodash.assign({}, config),
        bar,
        patterns,
        sourceCodes,
        fileQty,
        registry,
        failingRegistry,
        disabledConfigs = {},
        singleConfigs,
        specTwoConfigs,
        specThreeConfigs,
        defaultConfigs;

    // Set up a progress bar, as this process can take a long time
    bar = new ProgressBar("Determining Config: :percent [:bar] :elapseds elapsed, eta :etas ", {
        width: 30,
        total: BAR_TOTAL
    });
    bar.tick(0); // Shows the progress bar

    // Get the SourceCode of all chosen files
    patterns = answers.patterns.split(/[\s]+/);
    try {
        sourceCodes = getSourceCodeOfFiles(patterns, { baseConfig: newConfig, useEslintrc: false }, function(total) {
            bar.tick((BAR_SOURCE_CODE_TOTAL / total));
        });
    } catch (e) {
        log.info("\n");
        return callback(e);
    }
    fileQty = Object.keys(sourceCodes).length;
    if (fileQty === 0) {
        log.info("\n");
        return callback(new Error("Automatic Configuration failed.  No files were able to be parsed."));
    }

    // Create a registry of rule configs
    registry = new autoconfig.Registry();
    registry.populateFromCoreRules();

    // Lint all files with each rule config in the registry
    registry = registry.lintSourceCode(sourceCodes, newConfig, function(total) {
        bar.tick((BAR_TOTAL - BAR_SOURCE_CODE_TOTAL) / total); // Subtract out ticks used at beginning
    });
    debug("\nRegistry: " + util.inspect(registry.rules, {depth: null}));

    // Create a list of recommended rules, because we don't want to disable them
    var recRules = Object.keys(recConfig.rules).filter(function(ruleId) {
        return (recConfig.rules[ruleId] === 2 || recConfig.rules[ruleId][0] === 2);
    });

    // Find and disable rules which had no error-free configuration
    failingRegistry = registry.getFailingRulesRegistry();
    Object.keys(failingRegistry.rules).forEach(function(ruleId) {
        // If the rule is recommended, set it to error, otherwise disable it
        disabledConfigs[ruleId] = (recRules.indexOf(ruleId) !== -1) ? 2 : 0;
    });

    // Now that we know which rules to disable, strip out configs with errors
    registry = registry.stripFailingConfigs();

    // If there is only one config that results in no errors for a rule, we should use it.
    // createConfig will only add rules that have one configuration in the registry.
    singleConfigs = registry.createConfig().rules;

    // The "sweet spot" for number of options in a config seems to be two (severity plus one option).
    // Very often, a third option (usually an object) is available to address
    // edge cases, exceptions, or unique situations. We will prefer to use a config with
    // specificity of two.
    specTwoConfigs = registry.filterBySpecificity(2).createConfig().rules;

    // Maybe a specific combination using all three options works
    specThreeConfigs = registry.filterBySpecificity(3).createConfig().rules;

    // If all else fails, try to use the default (severity only)
    defaultConfigs = registry.filterBySpecificity(1).createConfig().rules;

    // Combine configs in reverse priority order (later take precedence)
    newConfig.rules = lodash.assign({}, disabledConfigs, defaultConfigs, specThreeConfigs, specTwoConfigs, singleConfigs);

    // Make sure progress bar has finished (floating point rounding)
    bar.update(BAR_TOTAL);

    // Log out some stats to let the user know what happened
    var totalRules = Object.keys(newConfig.rules).length;
    var enabledRules = Object.keys(newConfig.rules).filter(function(ruleId) {
        return (newConfig.rules[ruleId] !== 0);
    }).length;
    var resultMessage = [
        "\nEnabled " + enabledRules + " out of " + totalRules,
        "rules based on " + fileQty,
        "file" + ((fileQty === 1) ? "." : "s.")
    ].join(" ");
    log.info(resultMessage);
    return newConfig;
}

/**
 * process user's answers and create config object
 * @param {Object} answers answers received from inquirer
 * @param   {Object} callback function to call with any erorrs.
 * @returns {Object} config object
 */
function processAnswers(answers, callback) {
    var config = {rules: {}, env: {}};

    if (answers.es6) {
        config.env.es6 = true;
        if (answers.modules) {
            config.parserOptions = config.parserOptions || {};
            config.parserOptions.sourceType = "module";
        }
    }
    if (answers.commonjs) {
        config.env.commonjs = true;
    }
    answers.env.forEach(function(env) {
        config.env[env] = true;
    });
    if (answers.jsx) {
        config.parserOptions = config.parserOptions || {};
        config.parserOptions.ecmaFeatures = config.parserOptions.ecmaFeatures || {};
        config.parserOptions.ecmaFeatures.jsx = true;
        if (answers.react) {
            config.plugins = ["react"];
            config.parserOptions.ecmaFeatures.experimentalObjectRestSpread = true;
        }
    }

    if (answers.source === "prompt") {
        config.extends = "eslint:recommended";
        config.rules.indent = [2, answers.indent];
        config.rules.quotes = [2, answers.quotes];
        config.rules["linebreak-style"] = [2, answers.linebreak];
        config.rules.semi = [2, answers.semi ? "always" : "never"];
    }

    installModules(config);

    if (answers.source === "auto") {
        config = configureRules(answers, config, callback);
        config = autoconfig.extendFromRecommended(config);
    }
    return config;
}

/**
 * process user's style guide of choice and return an appropriate config object.
 * @param {string} guide name of the chosen style guide
 * @returns {Object} config object
 */
function getConfigForStyleGuide(guide) {
    var guides = {
        google: {extends: "google"},
        airbnb: {extends: "airbnb", plugins: ["react"]},
        standard: {extends: "standard", plugins: ["standard"]}
    };
    if (!guides[guide]) {
        throw new Error("You referenced an unsupported guide.");
    }

    installModules(guides[guide]);

    return guides[guide];
}

/* istanbul ignore next: no need to test inquirer*/
/**
 * Ask use a few questions on command prompt
 * @param {function} callback callback function when file has been written
 * @returns {void}
 */
function promptUser(callback) {
    var config;
    inquirer.prompt([
        {
            type: "list",
            name: "source",
            message: "How would you like to configure ESLint?",
            default: "prompt",
            choices: [
                {name: "Answer questions about your style", value: "prompt"},
                {name: "Use a popular style guide", value: "guide"},
                {name: "Inspect your JavaScript file(s)", value: "auto"}
            ]
        },
        {
            type: "list",
            name: "styleguide",
            message: "Which style guide do you want to follow?",
            choices: [{name: "Google", value: "google"}, {name: "AirBnB", value: "airbnb"}, {name: "Standard", value: "standard"}],
            when: function(answers) {
                return answers.source === "guide";
            }
        },
        {
            type: "input",
            name: "patterns",
            message: "Which file(s), path(s), or glob(s) should be examined?",
            when: function(answers) {
                return (answers.source === "auto");
            },
            validate: function(input) {
                if (input.trim().length === 0 && input.trim() !== ",") {
                    return "You must tell us what code to examine. Try again.";
                }
                return true;
            }
        },
        {
            type: "list",
            name: "format",
            message: "What format do you want your config file to be in?",
            default: "JavaScript",
            choices: ["JavaScript", "YAML", "JSON"],
            when: function(answers) {
                return (answers.source === "guide" || answers.source === "auto");
            }
        }
    ], function(earlyAnswers) {

        // early exit if you are using a style guide
        if (earlyAnswers.source === "guide") {
            config = getConfigForStyleGuide(earlyAnswers.styleguide);
            writeFile(config, earlyAnswers.format, callback);
            return;
        }

        // continue with the questions otherwise...
        inquirer.prompt([
            {
                type: "confirm",
                name: "es6",
                message: "Are you using ECMAScript 6 features?",
                default: false
            },
            {
                type: "confirm",
                name: "modules",
                message: "Are you using ES6 modules?",
                default: false,
                when: function(answers) {
                    return answers.es6 === true;
                }
            },
            {
                type: "checkbox",
                name: "env",
                message: "Where will your code run?",
                default: ["browser"],
                choices: [{name: "Node", value: "node"}, {name: "Browser", value: "browser"}]
            },
            {
                type: "confirm",
                name: "commonjs",
                message: "Do you use CommonJS?",
                default: false,
                when: function(answers) {
                    return answers.env.some(function(env) {
                        return env === "browser";
                    });
                }
            },
            {
                type: "confirm",
                name: "jsx",
                message: "Do you use JSX?",
                default: false
            },
            {
                type: "confirm",
                name: "react",
                message: "Do you use React",
                default: false,
                when: function(answers) {
                    return answers.jsx;
                }
            }
        ], function(secondAnswers) {

            // early exit if you are using automatic style generation
            if (earlyAnswers.source === "auto") {
                if (secondAnswers.jsx) {
                    log.error("Unfortunately, autoconfig does not yet work for JSX code.\nPlease see https://github.com/eslint/eslint/issues/5007 for current status.");
                    return;
                }
                var combinedAnswers = lodash.assign({}, earlyAnswers, secondAnswers);
                config = processAnswers(combinedAnswers, callback);
                installModules(config);
                writeFile(config, earlyAnswers.format, callback);
                return;
            }

            // continue with the style questions otherwise...
            inquirer.prompt([
                {
                    type: "list",
                    name: "indent",
                    message: "What style of indentation do you use?",
                    default: "tabs",
                    choices: [{name: "Tabs", value: "tab"}, {name: "Spaces", value: 4}]
                },
                {
                    type: "list",
                    name: "quotes",
                    message: "What quotes do you use for strings?",
                    default: "double",
                    choices: [{name: "Double", value: "double"}, {name: "Single", value: "single"}]
                },
                {
                    type: "list",
                    name: "linebreak",
                    message: "What line endings do you use?",
                    default: "unix",
                    choices: [{name: "Unix", value: "unix"}, {name: "Windows", value: "windows"}]
                },
                {
                    type: "confirm",
                    name: "semi",
                    message: "Do you require semicolons?",
                    default: true
                },
                {
                    type: "list",
                    name: "format",
                    message: "What format do you want your config file to be in?",
                    default: "JavaScript",
                    choices: ["JavaScript", "YAML", "JSON"]
                }
            ], function(answers) {
                var totalAnswers = lodash.assign({}, earlyAnswers, secondAnswers, answers);
                config = processAnswers(totalAnswers);
                installModules(config);
                writeFile(config, answers.format, callback);
            });
        });
    });
}

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

var init = {
    getConfigForStyleGuide: getConfigForStyleGuide,
    processAnswers: processAnswers,
    initializeConfig: /* istanbul ignore next */ function(callback) {
        promptUser(callback);
    }
};

module.exports = init;
