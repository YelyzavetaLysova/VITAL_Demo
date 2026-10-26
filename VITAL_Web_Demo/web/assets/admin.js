"use strict";

const $ = (selector) => document.querySelector(selector);
let articles = [];
let editingId = null;
let imagePath = "";
let originalImageUrl = "";
let articleBlocks = [];
let importedText = "";
let refreshTimer;

function node(tag, text = "") {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
}
async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers:
      body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {},
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Check the article fields and try again.",
    );
  return data;
}

function editor(record = {}) {
  editingId = record.id || null;
  articleBlocks = record.blocks || [];
  importedText = record.text || "";
  imagePath = record.image_url || "";
  originalImageUrl = record.original_image_url || "";
  for (const [selector, key] of [
    ["#editTitle", "title"],
    ["#editPublisher", "publisher"],
    ["#editAuthor", "author"],
    ["#editDate", "published_at"],
    ["#editUrl", "url"],
    ["#editText", "text"],
  ])
    $(selector).value = record[key] || "";
  $("#editLanguage").value = record.language || "en";
  $("#editTheme").value = record.theme || "other";
  $("#editCountry").value = record.country || "NO";
  $("#editImage").value = "";
  $("#saveMessage").textContent = "";
  preview();
  $("#editor").hidden = false;
  $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
}
function preview() {
  $("#imagePreview").hidden = !imagePath;
  if (imagePath) $("#imagePreview").src = imagePath;
}

async function refresh() {
  try {
    articles = await api("/api/admin/articles");
    $("#loginPanel").hidden = true;
    $("#adminWorkspace").hidden = false;
    if (!$("#shareUrl").value)
      $("#shareUrl").value = (await api("/api/admin/share")).url;
    $("#adminArticles").replaceChildren();
    $("#adminMessage").textContent = articles.length
      ? ""
      : "No saved articles yet.";
    for (const article of articles) {
      const row = node("div");
      row.className = "admin-story";
      const description = node("div");
      description.append(node("h3", article.title));
      const status = node(
        "p",
        [
          "Visible to visitors",
          ["detecting", "checking", "classifying"].includes(
            article.analysis?.phase,
          )
            ? article.analysis?.remote_status === "queued"
              ? "Queued for analysis"
              : "Analysis in progress"
            : article.analysis?.message || "Not analysed",
          article.prepared_at
            ? `Prepared ${new Date(article.prepared_at).toLocaleString()}`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      status.className = "small muted";
      description.append(status);
      const actions = node("div");
      actions.className = "actions";
      const edit = node("button", "Edit");
      edit.addEventListener("click", () => editor(article));
      const prepare = node(
        "button",
        ["detecting", "checking", "classifying"].includes(
          article.analysis?.phase,
        )
          ? article.analysis?.remote_status === "queued"
            ? "Queued"
            : "Analysing…"
          : article.analysis
            ? "Preprocess again"
            : "Preprocess",
      );
      prepare.disabled = ["detecting", "checking", "classifying"].includes(
        article.analysis?.phase,
      );
      prepare.addEventListener("click", async () => {
        prepare.disabled = true;
        try {
          await api(`/api/admin/articles/${article.id}/prepare`, "POST");
          await refresh();
        } catch (error) {
          $("#adminMessage").textContent = error.message;
          prepare.disabled = false;
        }
      });
      const remove = node("button", "Delete");
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete “${article.title}”?`)) return;
        try {
          await api(`/api/admin/articles/${article.id}`, "DELETE");
          await refresh();
        } catch (error) {
          $("#adminMessage").textContent = error.message;
        }
      });
      actions.append(edit, prepare);
      if (article.analysis?.server_response) {
        const inspect = node("button", "Server response");
        inspect.addEventListener("click", async () => {
          try {
            $("#serverResponse").textContent = JSON.stringify(
              await api(`/api/admin/articles/${article.id}/server-response`),
              null,
              2,
            );
            $("#responseDialog").showModal();
          } catch (error) {
            $("#adminMessage").textContent = error.message;
          }
        });
        actions.append(inspect);
      }
      {
        const view = node("a", "View ↗");
        view.href = `/article/${article.id}`;
        view.target = "_blank";
        actions.append(view);
      }
      actions.append(remove);
      row.append(description, actions);
      $("#adminArticles").append(row);
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 3000);
  } catch {
    $("#loginPanel").hidden = false;
    $("#adminWorkspace").hidden = true;
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/login", "POST", { password: $("#password").value });
    $("#password").value = "";
    await refresh();
  } catch (error) {
    $("#loginMessage").textContent = error.message;
  }
});
$("#logout").addEventListener("click", async () => {
  clearTimeout(refreshTimer);
  await api("/api/admin/logout", "POST", {});
  $("#adminWorkspace").hidden = true;
  $("#loginPanel").hidden = false;
});
$("#closeResponse").addEventListener("click", () =>
  $("#responseDialog").close(),
);
$("#copyLink").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#shareUrl").value);
    $("#shareMessage").textContent = "Link copied.";
  } catch {
    $("#shareUrl").select();
    $("#shareMessage").textContent = "Select and copy this URL.";
  }
});
$("#downloadQr").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/admin/qr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: $("#shareUrl").value }),
    });
    if (!response.ok) throw new Error("Enter a complete visitor URL.");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "VITAL-demo-QR.png";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("#shareMessage").textContent = "QR code downloaded.";
  } catch (error) {
    $("#shareMessage").textContent = error.message;
  }
});
$("#newManual").addEventListener("click", () => editor());
$("#cancelEdit").addEventListener("click", () => {
  $("#editor").hidden = true;
});
$("#removeImage").addEventListener("click", () => {
  imagePath = "";
  originalImageUrl = "";
  preview();
});
$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#importForm button");
  button.disabled = true;
  $("#importMessage").textContent = "Importing article and image.";
  try {
    const record = await api("/api/admin/import", "POST", {
      url: $("#importUrl").value,
    });
    editor(record);
    $("#importMessage").textContent =
      (record.warnings || []).join(" ") ||
      "Imported. Review the text and metadata below.";
  } catch (error) {
    $("#importMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#editImage").addEventListener("change", async () => {
  if (!$("#editImage").files[0]) return;
  const body = new FormData();
  body.append("file", $("#editImage").files[0]);
  try {
    const result = await api("/api/admin/image", "POST", body);
    imagePath = result.image_url;
    originalImageUrl = "";
    preview();
  } catch (error) {
    $("#saveMessage").textContent = error.message;
  }
});
$("#articleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#articleForm button[type='submit']");
  button.disabled = true;
  $("#saveMessage").textContent = "Saving.";
  const body = {
    title: $("#editTitle").value,
    text: $("#editText").value,
    url: $("#editUrl").value,
    publisher: $("#editPublisher").value,
    author: $("#editAuthor").value,
    published_at: $("#editDate").value,
    language: $("#editLanguage").value,
    country: $("#editCountry").value,
    theme: $("#editTheme").value,
    image_url: imagePath,
    original_image_url: originalImageUrl,
    blocks:
      $("#editText").value === importedText
        ? articleBlocks
        : [
            ...$("#editText")
              .value.split(/\n\s*\n/)
              .filter(Boolean)
              .map((text) => ({ type: "paragraph", text })),
            ...articleBlocks.filter((block) => block.type === "image"),
          ],
  };
  try {
    const result = await api(
      editingId ? `/api/admin/articles/${editingId}` : "/api/admin/articles",
      editingId ? "PUT" : "POST",
      body,
    );
    editingId = result.id;
    $("#saveMessage").textContent =
      "Saved. The article is visible on the front page.";
    await refresh();
  } catch (error) {
    $("#saveMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
refresh();

$("#exportFeedback").addEventListener("click", async () => {
  try {
    const data = await api("/api/admin/feedback");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = node("a");
    link.href = url;
    link.download = "VITAL-feedback.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    $("#adminMessage").textContent = error.message;
  }
});
