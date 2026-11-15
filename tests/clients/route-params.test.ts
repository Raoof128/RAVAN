import { expect, it } from "vitest";
import { routeParam } from "../../apps/web/src/router.js";

it("reads an id from the address, and treats a broken one as no id at all", () => {
  expect(routeParam("/movie/abc-123", "/movie/")).toBe("abc-123");
  expect(routeParam("/player/a%20b?start=0", "/player/")).toBe("a b");
  expect(routeParam("/settings", "/movie/")).toBeUndefined();
  // decodeURIComponent throws on these; thrown while rendering, that blanked
  // the whole app until the address was edited by hand.
  for (const broken of ["/movie/%E0%A4%A", "/player/%", "/movie/%zz"])
    expect(
      routeParam(broken, broken.startsWith("/movie/") ? "/movie/" : "/player/"),
      broken,
    ).toBeUndefined();
  expect(routeParam("/movie/", "/movie/")).toBeUndefined();
});
