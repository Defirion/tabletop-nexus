const gamesRoot = document.querySelector("#games");
const count = document.querySelector("#library-count");

function capabilityLabel(game) {
  const labels = ["TV-less"];
  if (game.capabilities.personalDevices) labels.push("phones");
  if (game.capabilities.dedicatedDisplay) labels.push("TV display");
  return labels.join(" · ");
}

function card(game) {
  const article = document.createElement("article");
  article.className = "game-card";

  const status = document.createElement("span");
  status.className = "status";
  status.textContent = game.status;

  const title = document.createElement("h3");
  title.textContent = game.name;

  const description = document.createElement("p");
  description.textContent = game.description ?? "Compatible Tabletop Nexus game.";

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${game.players.min}–${game.players.max} players · ${capabilityLabel(game)}`;

  article.append(status, title, description, meta);
  return article;
}

async function loadGames() {
  try {
    const response = await fetch("/api/games", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { games } = await response.json();

    count.textContent = String(games.length);
    gamesRoot.replaceChildren();

    if (games.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No games configured yet. Copy nexus.config.example.json to nexus.config.json and add a compatible game path.";
      gamesRoot.append(empty);
      return;
    }

    for (const game of games) gamesRoot.append(card(game));
  } catch (error) {
    count.textContent = "!";
    const message = document.createElement("p");
    message.className = "empty error";
    message.textContent = `Could not load the local library: ${error instanceof Error ? error.message : "unknown error"}`;
    gamesRoot.replaceChildren(message);
  }
}

void loadGames();
