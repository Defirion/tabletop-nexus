const gamesRoot = document.querySelector("#games");
const statusRoot = document.querySelector("#library-status");

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderGame(game) {
  const card = document.createElement("article");
  card.className = "game-card";
  card.append(textElement("h3", "game-title", game.name));
  if (game.description) card.append(textElement("p", "game-description", game.description));
  card.append(textElement("p", "game-meta", `${game.players.min}–${game.players.max} players · TV-less`));
  card.append(textElement("span", "status-pill", game.status));
  return card;
}

async function load() {
  try {
    const response = await fetch("/api/games", { cache: "no-store" });
    if (!response.ok) throw new Error(`Library request failed: ${response.status}`);
    const { games } = await response.json();

    gamesRoot.replaceChildren();
    if (games.length === 0) {
      gamesRoot.append(textElement("p", "empty-state", "No games are configured yet."));
      statusRoot.textContent = "0 configured";
      return;
    }

    for (const game of games) gamesRoot.append(renderGame(game));
    statusRoot.textContent = `${games.length} configured`;
  } catch (error) {
    console.error(error);
    gamesRoot.replaceChildren(textElement("p", "error-state", "The local game library could not be loaded."));
    statusRoot.textContent = "Unavailable";
  }
}

void load();
