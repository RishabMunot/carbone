// A problem with the template or its data: the HTTP layer answers 422 with its message.
class RenderError extends Error {}

module.exports = { RenderError };
