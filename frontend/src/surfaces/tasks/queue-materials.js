import { renderIcon } from "../../core/icons.js";

// A task's supporting materials as one small icon control in its queue row.
// One material is a direct link (or a button for a process doc); several are
// a single trigger that opens a short menu naming each. The menu is fixed to
// the viewport because the queue board clips its overflow.
export function renderQueueMaterials(materials, options = {}) {
  if (!Array.isArray(materials) || materials.length === 0) return null;
  const { taskTitle = "task", openDoc = () => {} } = options;
  if (materials.length === 1) {
    const control = materialControl(materials[0], openDoc, "dk-icon-button dk-icon-button--sm ops-queue-material");
    const name = materialName(materials[0]);
    control.title = name;
    control.setAttribute("aria-label", `${materials[0].href ? "Open" : "Open process doc"} ${name}`);
    control.append(renderIcon(materials[0].icon || "instructions"));
    return control;
  }
  return renderMaterialsMenu(materials, taskTitle, openDoc);
}

function materialName(material) {
  return material.detail && material.detail !== material.label
    ? `${material.label} · ${material.detail}`
    : material.label;
}

function materialControl(material, openDoc, className) {
  if (material.href) {
    const link = document.createElement("a");
    link.className = className;
    link.href = material.href;
    link.target = "_blank";
    link.rel = "noopener";
    return link;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.addEventListener("click", () => openDoc(material));
  return button;
}

let menuSequence = 0;

function renderMaterialsMenu(materials, taskTitle, openDoc) {
  const wrap = document.createElement("span");
  wrap.className = "ops-queue-materials";
  const menuId = `ops-queue-materials-${(menuSequence += 1)}`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dk-icon-button dk-icon-button--sm ops-queue-material";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", menuId);
  trigger.setAttribute("aria-label", `${materials.length} supporting materials for ${taskTitle}`);
  trigger.title = materials.map(materialName).join("\n");
  const count = document.createElement("span");
  count.className = "ops-queue-material-count dk-mono";
  count.setAttribute("aria-hidden", "true");
  count.textContent = String(materials.length);
  trigger.append(renderIcon("instructions"), count);

  const menu = document.createElement("div");
  menu.className = "dk-menu ops-queue-materials-menu";
  menu.id = menuId;
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  for (const material of materials) {
    const item = materialControl(material, (picked) => {
      close();
      openDoc(picked);
    }, "dk-menu__item");
    item.setAttribute("role", "menuitem");
    item.title = material.href || material.label;
    const label = document.createElement("span");
    label.className = "ops-queue-material-label";
    label.textContent = material.label;
    item.append(renderIcon(material.icon || "link", { size: 16 }), label);
    if (material.detail && material.detail !== material.label) {
      const detail = document.createElement("span");
      detail.className = "ops-queue-material-detail";
      detail.textContent = material.detail;
      item.append(detail);
    }
    if (material.href) item.addEventListener("click", () => close());
    menu.append(item);
  }

  const onOutside = (event) => {
    if (!wrap.contains(event.target)) close();
  };
  const onViewportChange = () => close();
  function open() {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const box = trigger.getBoundingClientRect?.();
    if (box) {
      const width = menu.offsetWidth || 240;
      menu.style.top = `${Math.round(box.bottom + 4)}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - width - 8)))}px`;
    }
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    menu.querySelector(".dk-menu__item")?.focus?.();
  }
  function close(options = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    if (options.restoreFocus) trigger.focus?.();
  }
  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll(".dk-menu__item")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus?.();
    } else if (event.key === "Tab") {
      close();
    }
  });
  wrap.append(trigger, menu);
  return wrap;
}
