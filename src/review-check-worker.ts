export default {
  fetch(): Response {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
