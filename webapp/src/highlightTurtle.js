// Prism's language components are legacy scripts that expect a global `Prism`.
// Register the small Turtle grammar directly on the imported instance so lazy
// production chunks do not depend on global-script execution order.

import Prism from "prismjs"

Prism.languages.turtle = {
    comment: {
        pattern: /#.*/,
        greedy: true,
    },
    "multiline-string": {
        pattern: /"""(?:(?:""?)?(?:[^"\\]|\\.))*"""|'''(?:(?:''?)?(?:[^'\\]|\\.))*'''/,
        greedy: true,
        alias: "string",
        inside: { comment: /#.*/ },
    },
    string: {
        pattern: /"(?:[^\\"\r\n]|\\.)*"|'(?:[^\\'\r\n]|\\.)*'/,
        greedy: true,
    },
    url: {
        pattern: /<(?:[^\x00-\x20<>"{}|^`\\]|\\(?:u[\da-fA-F]{4}|U[\da-fA-F]{8}))*>/,
        greedy: true,
        inside: { punctuation: /[<>]/ },
    },
    function: {
        pattern: /(?:(?![-.\d\xB7])[-.\w\xB7\xC0-\uFFFD]+)?:(?:(?![-.])(?:[-.:\w\xC0-\uFFFD]|%[\da-f]{2}|\\.)+)?/i,
        inside: {
            "local-name": {
                pattern: /([^:]*:)[\s\S]+/,
                lookbehind: true,
            },
            prefix: {
                pattern: /[\s\S]+/,
                inside: { punctuation: /:/ },
            },
        },
    },
    number: /[+-]?\b\d+(?:\.\d*)?(?:e[+-]?\d+)?/i,
    punctuation: /[{}.,;()[\]]|\^\^/,
    boolean: /\b(?:false|true)\b/,
    keyword: [/(?:\ba|@prefix|@base)\b|=/, /\b(?:base|graph|prefix)\b/i],
    tag: {
        pattern: /@[a-z]+(?:-[a-z\d]+)*/i,
        inside: { punctuation: /@/ },
    },
}
Prism.languages.trig = Prism.languages.turtle

export const highlightTurtle = (turtle) =>
    Prism.highlight(turtle, Prism.languages.turtle, "turtle")
