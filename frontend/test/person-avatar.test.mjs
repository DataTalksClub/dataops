import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { personAvatar, personInitials, personPhotoUrl, updatePersonAvatar } from "../src/core/identity.js";
import { FakeDocument } from "./support/fake-dom.mjs";

const STUB = "https://lh3.googleusercontent.com/a/stub-orin=s96-c";

describe("person avatar", () => {
  test("asks Google for one 64px cropped photo, whatever size it came with", () => {
    assert.equal(personPhotoUrl(STUB), "https://lh3.googleusercontent.com/a/stub-orin=s64-c");
    assert.equal(personPhotoUrl("https://lh3.googleusercontent.com/a/stub-orin"), "https://lh3.googleusercontent.com/a/stub-orin=s64-c");
    assert.equal(
      personPhotoUrl("https://lh3.googleusercontent.com/-x/AAAA/AAAA/y/s96-c/photo.jpg"),
      "https://lh3.googleusercontent.com/-x/AAAA/AAAA/y/s64-c/photo.jpg",
    );
  });

  test("ignores anything that is not an https Google photo", () => {
    for (const picture of ["", undefined, null, "http://lh3.googleusercontent.com/a/x", "https://tracker.example/x.gif", "javascript:alert(1)", "nope"]) {
      assert.equal(personPhotoUrl(picture), "", String(picture));
    }
  });

  test("without a picture it is the initials only", () => {
    const doc = new FakeDocument();
    const avatar = personAvatar({ name: "Orin Vale" }, { document: doc, size: "xs", className: "ops-queue-avatar" });
    assert.ok(avatar.classList.contains("dk-avatar"));
    assert.ok(avatar.classList.contains("dk-avatar--xs"));
    assert.ok(avatar.classList.contains("ops-queue-avatar"));
    assert.equal(avatar.getAttribute("aria-hidden"), "true");
    assert.equal(avatar.textContent, "OV");
    assert.equal(avatar.querySelector("img"), null);
    assert.equal(personInitials("Orin Vale"), "OV");
  });

  test("with a picture the photo sits over the initials, without a referrer", () => {
    const doc = new FakeDocument();
    const avatar = personAvatar({ name: "Orin Vale", picture: STUB }, { document: doc });
    const img = avatar.querySelector("img");
    assert.equal(img.getAttribute("src"), "https://lh3.googleusercontent.com/a/stub-orin=s64-c");
    assert.equal(img.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(img.alt, "");
    assert.equal(avatar.textContent, "OV", "initials stay under the photo");
    assert.equal(avatar.dataset.avatarPhoto, "shown");
  });

  test("a photo that fails to load falls back to the initials", async () => {
    const doc = new FakeDocument();
    const avatar = personAvatar({ name: "Orin Vale", picture: STUB }, { document: doc });
    await avatar.querySelector("img").dispatch("error");
    assert.equal(avatar.querySelector("img"), null);
    assert.equal(avatar.textContent, "OV");
    assert.equal(avatar.dataset.avatarPhoto, "failed");
  });

  test("updating a placed avatar replaces its placeholder", () => {
    const doc = new FakeDocument();
    const node = doc.createElement("span");
    node.className = "dk-avatar dk-avatar--sm";
    node.textContent = "?";
    updatePersonAvatar(node, { name: "Grace Young", picture: STUB });
    assert.equal(node.textContent, "GY");
    assert.ok(node.querySelector("img"));
    updatePersonAvatar(node, "Valeriia");
    assert.equal(node.textContent, "V");
    assert.equal(node.querySelector("img"), null);
  });
});
