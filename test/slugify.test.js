const test = require("node:test");
const assert = require("node:assert");
const ApiServer = require("../src/ApiServer.class");
const { createApiServer } = require("../test-helpers/fake-mongoose.js");

const createApi = () => createApiServer(ApiServer);

test("slugify maps every character its pattern matches", () => {
    const api = createApi();
    assert.equal(api.slugify("Session 1"), "Session_1");
    assert.equal(api.slugify("user@example.com"), "user_at_example_dot_com");
    // An NBSP is matched by \s but is not in the replacement map: the unmapped
    // match used to be spliced in as the literal string "undefined".
    assert.equal(api.slugify("Session\u00a01"), "Session_1");
    assert.equal(api.slugify("a\tb"), "a_b");
    assert.equal(api.slugify("a\u3000b"), "a_b");
});
