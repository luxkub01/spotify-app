var redirect_uri = `${window.location.origin}/`;
var client_id = '3629edd575284d0aa6671c69ae8fb3d3';
var access_token = null;
var refresh_token = null;
var currentPlaylist = "";
var savedTracks = [];
var allsavedTracks = [];
var savedTracksIds = [];
var selectedArtists = []; // Array to store selected artist names
var nextBatchLength = 0;
var ArtistTracks = [];
var playlistTracksIds = [];


const AUTHORIZE = "https://accounts.spotify.com/authorize";
const loading = document.getElementById("loading");
const progress = document.getElementById("progress");
const loginButton = document.getElementById("loginButton");
const createPlaylistButton = document.getElementById("createPlaylistButton");
const artistsContainer = document.getElementById("artistsContainer");
const showArtistsContainer = document.getElementById("showArtistsContainer");
const tokenTimestamp = sessionStorage.getItem("token_timestamp");
const CACHE_KEY_TRACKS = "cached_saved_tracks";  // full track objects
const CACHE_KEY_IDS = "cached_saved_ids";     // array of ids
const CACHE_KEY_TIMESTAMP = "cached_saved_ts";      // ms since epoch
const CACHE_TTL_MS = 1000 * 60 * 10;         // 10-minute freshness
if (tokenTimestamp && (Date.now() - parseInt(tokenTimestamp)) > 3600 * 1000) {
    sessionStorage.clear();
    requestAuthorization();
}

let savedTrackIdsSet = new Set();

document.addEventListener("DOMContentLoaded", function () {
    const userMenu = document.getElementById("userMenu");
    const userDropdown = document.getElementById("userDropdown");

    if (userMenu) {
        userMenu.addEventListener("click", function (e) {
            e.stopPropagation(); // Prevent event bubbling

            const isActive = userDropdown.classList.toggle("show-dropdown");

            // Toggle 'active' class on userMenu based on dropdown visibility
            if (isActive) {
                userMenu.classList.add("active");
            } else {
                userMenu.classList.remove("active");
            }
        });

        // Close dropdown if clicking outside userMenu
        document.addEventListener("click", function (e) {
            if (!userMenu.contains(e.target)) {
                userDropdown.classList.remove("show-dropdown");
                userMenu.classList.remove("active"); // Also remove active class
            }
        });
    }
});

function loadTracksFromCache() {
    const ts = +localStorage.getItem(CACHE_KEY_TIMESTAMP) || 0;
    if (Date.now() - ts > CACHE_TTL_MS) return false;

    try {
        const slimTracks = JSON.parse(localStorage.getItem(CACHE_KEY_TRACKS)) || [];
        allsavedTracks = slimTracks.map(t => ({
            track: {
                id: t.id,
                name: t.name,
                artists: t.artists,
            }
        }));
        savedTrackIdsSet = new Set(JSON.parse(localStorage.getItem(CACHE_KEY_IDS)) || []);
        return allsavedTracks.length > 0;
    } catch (e) {
        console.warn("bad cache → ignore", e);
        return false;
    }
}

function saveTracksToCache() {
    // Only cache what's needed: track id + artist name + name
    const slimTracks = allsavedTracks.map(item => ({
        id: item.track.id,
        name: item.track.name,
        artists: item.track.artists.map(a => a.name),
    }));

    localStorage.setItem(CACHE_KEY_TRACKS, JSON.stringify(slimTracks));
    localStorage.setItem(CACHE_KEY_IDS, JSON.stringify([...savedTrackIdsSet]));
    localStorage.setItem(CACHE_KEY_TIMESTAMP, Date.now().toString());
}

async function cacheSavedTrackIds() {
    const usedSessionFlag = sessionStorage.getItem("tracks_loaded_this_session") === "true";
    const usedCache = loadTracksFromCache();

    if (usedSessionFlag || usedCache) {
        console.log("✅ loaded saved tracks from", usedSessionFlag ? "session flag" : "localStorage cache");
        return;
    }

    console.log("⏳ fetching saved tracks from Spotify API...");

    savedTrackIdsSet.clear();
    allsavedTracks = [];
    let offset = 0;

    while (true) {
        const res = await fetch(`https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`, {
            headers: { Authorization: `Bearer ${sessionStorage.getItem("access_token")}` }
        });
        const data = await res.json();
        if (!data.items || !data.items.length) break;

        data.items.forEach(item => {
            savedTrackIdsSet.add(item.track.id);
            allsavedTracks.push(item);
        });

        offset += 50;
    }

    saveTracksToCache();
    sessionStorage.setItem("tracks_loaded_this_session", "true");
    console.log("✅ finished fetching from Spotify API — cached", allsavedTracks.length, "tracks");
}

async function getArtistIdByName(name) {
    const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=10`, {
        headers: { Authorization: `Bearer ${sessionStorage.getItem("access_token")}` }
    });
    const data = await res.json();

    // Try to find exact match (case-insensitive)
    const exact = data.artists.items.find(a => a.name.toLowerCase() === name.toLowerCase());
    return exact?.id || data.artists.items[0]?.id || null;
}

async function getUnheardTracksByArtist(artistId) {
    const token = sessionStorage.getItem("access_token");
    const url = `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&market=US&limit=50`;

    const albumRes = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const albumData = await albumRes.json();

    const albumIds = [...new Set(
        albumData.items
            .filter(album => album.artists.some(a => a.id === artistId))
            .map(album => album.id)
    )];

    let unheardTracks = [];

    for (let albumId of albumIds) {
        const tracksRes = await fetch(`https://api.spotify.com/v1/albums/${albumId}/tracks`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const trackData = await tracksRes.json();

        for (let track of trackData.items) {
            const isByTargetArtist = track.artists.some(a => a.id === artistId);
            const title = track.name.toLowerCase();
            const isUnwanted = title.includes("live") || title.includes("remix") || title.includes("karaoke");

            if (!savedTrackIdsSet.has(track.id) && isByTargetArtist && !isUnwanted) {
                unheardTracks.push(track);
            }
        }
    }

    return unheardTracks;
}

function isAccessTokenExpired() {
    const token = sessionStorage.getItem("access_token");
    const expiresAt = parseInt(sessionStorage.getItem("token_expires_at"), 10);
    return !token || !expiresAt || Date.now() > expiresAt;
}

function storeTokenFromHash() {
    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get("access_token");
        const expiresIn = parseInt(params.get("expires_in"), 10); // Get token lifespan

        if (token && expiresIn) {
            sessionStorage.setItem("access_token", token);
            sessionStorage.setItem("token_expires_at", Date.now() + expiresIn * 1000);
            sessionStorage.setItem("token_timestamp", Date.now()); // Optional tracking
            window.location.hash = ""; // Clean URL
        }
    }
}

function isTokenExpired() {
    const exp = parseInt(sessionStorage.getItem("token_expires_at"), 10);
    return exp ? Date.now() >= exp : true;
}

function logout() {
    sessionStorage.clear();
    sessionStorage.setItem("just_logged_out", "true"); // 👈 prevent loop
    const w = window.open("https://accounts.spotify.com/logout", "_blank");
    setTimeout(() => {
        if (w) w.close();
        window.location.href = window.location.origin;
    }, 1400);
}

async function loadUserProfile() {
    const token = sessionStorage.getItem("access_token");
    if (!token) return;

    try {
        const res = await fetch("https://api.spotify.com/v1/me", {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!res.ok) {
            console.error("Spotify /me API failed with status", res.status);
            logout();
            return;
        }

        const data = await res.json();
        console.log("Spotify profile data:", data);

        const greet = document.getElementById("mainGreeting");
        const userMenu = document.getElementById("userMenu");
        const userPic = document.getElementById("userPic");
        const userName = document.getElementById("userName");

        if (userMenu && userPic && userName) {
            userPic.src = data.images?.[0]?.url || "https://via.placeholder.com/40";
            userName.textContent = data.display_name || "User";
            userMenu.style.display = "flex";
        }

        if (greet) {
            const greetings = [
                `Hi, ${data.display_name}! 👋`,
                `Welcome back, ${data.display_name}!`,
                `You’re in, ${data.display_name}. Time to explore.`,
                `Your sound awaits, ${data.display_name}.`,
                `Let’s make today sound better, ${data.display_name}.`
            ];
            greet.textContent = greetings[Math.floor(Math.random() * greetings.length)];
        }

    } catch (err) {
        console.error("Failed to load user profile:", err);
    }
}

// ----- INIT: Token check and profile load
(function bootstrapSpotifyAuth() {
    storeTokenFromHash();

    if (sessionStorage.getItem("just_logged_out")) {
        sessionStorage.removeItem("just_logged_out");
        return;
    }

    if (isTokenExpired()) {
        logout();
        return;
    }

    setInterval(() => {
        if (isTokenExpired()) {
            console.log("Token expired. Logging out...");
            logout();
        }
    }, 10000);

    loadUserProfile();
})();

async function fetchWebApi(endpoint, method, body) {
    let accessToken = sessionStorage.getItem("access_token");
    if (!accessToken) {
        console.error("Access token not found");
        return null;
    }

    const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    // FIX: Avoid double 'https://api.spotify.com/' prefix
    const baseUrl = endpoint.startsWith("http")
        ? endpoint
        : `https://api.spotify.com/${endpoint}`;

    const res = await fetch(baseUrl, options);

    if (!res.ok) {
        console.error(`Spotify API error ${res.status} on ${endpoint}`);
        const text = await res.text();
        console.warn("Response body:", text);
        return null;
    }

    return await res.json();
}

async function getTopArtists() {
    const artists = (await fetchWebApi(
        'v1/me/top/artists?time_range=long_term&limit=20', 'GET'
    )).items;
    return artists;
}

async function createPlaylist(tracksUri) {
    try {
        const { id: user_id } = await fetchWebApi('v1/me', 'GET');

        const playlist = await fetchWebApi(
            `v1/users/${user_id}/playlists`, 'POST', {
            "name": "For you",
            "description": generatePlaylistDescription(selectedArtists),
            "public": false
        },
        );

        if (!playlist || !playlist.id) {
            throw new Error("Playlist ID not found");
        }

        // Convert tracks URIs to objects with URIs
        const tracks = tracksUri.map(uri => ({ "uri": uri }));

        // Add tracks one by one to ensure they are added sequentially
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            await fetchWebApi(
                `v1/playlists/${playlist.id}/tracks`,
                'POST',
                { "uris": [track.uri] }, // Each track should be added as an array
                sessionStorage.getItem("access_token")
            );
        }

        return playlist;
    } catch (error) {
        console.error("Error creating playlist:", error);
        throw error;
    }
}

function generatePlaylistDescription(artists) {
    if (artists.length === 1) {
        return `A personalized playlist featuring ${artists[0]} and more`;
    } else if (artists.length === 2) {
        return `A personalized playlist featuring ${artists[0]}, ${artists[1]}, and more`;
    } else {
        return `A personalized playlist featuring ${artists[0]}, ${artists[1]}, ${artists[2]} and more`;
    }
}

async function init() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const header = document.querySelector(".artists-header");
    const titleHeader = document.getElementById("titleHeader");

    header.style.display = "none";
    titleHeader.style.display = "none";
    createPlaylistButton.style.display = "none";
    showArtistsContainer.style.display = "none";

    loading.style.display = "block";
    progress.style.display = "block";

    if (!loadTracksFromCache()) {
        await cacheSavedTrackIds();
    }

    const allTracks = [];

    for (const artistName of selectedArtists) {
        const artistId = await getArtistIdByName(artistName);
        console.log("Resolved artist ID:", artistId, "for name:", artistName);

        if (!artistId) {
            console.warn(`❌ No ID found for ${artistName}`);
            continue;
        }

        // 1. Grab user's saved tracks by this artist
        const userTracks = allsavedTracks
            .filter(t => t.track.artists.some(a => a.id === artistId))
            .map(t => t.track);

        const savedNames = new Set(userTracks.map(t => t.name.toLowerCase()));
        const selectedUserTracks = getRandomTracks(userTracks, 3);

        // 2. Get unheard tracks by artist
        const unheardTracks = await getUnheardTracksByArtist(artistId);
        const filteredUnheardTracks = unheardTracks.filter(t =>
            !savedNames.has(t.name.toLowerCase())
        );
        const recommendedTracks = getRandomTracks(filteredUnheardTracks, 3);

        // Add all tracks to shared pool
        allTracks.push(...selectedUserTracks, ...recommendedTracks);

        // Log results
        console.log(`🎧 Final Picks for ${artistName}:`, [
            ...selectedUserTracks.map(t => t.name),
            ...recommendedTracks.map(t => t.name)
        ]);
    }

    if (allTracks.length === 0) {
        console.warn("❌ No new tracks gathered. Aborting.");
        loading.style.display = "none";
        progress.style.display = "none";
        titleHeader.textContent = "No playlist created. Try different artists.";
        titleHeader.style.display = "block";
        return;
    }

    const interleaved = smartShuffle(allTracks, t => t.artists[0]?.name || "");
    const playlistTracksIds = interleaved.map(t => t.id);
    const tracksUri = playlistTracksIds.map(id => `spotify:track:${id}`);
    const createdPlaylist = await createPlaylist(tracksUri);
    console.log("✅ Playlist created:", createdPlaylist);

    loading.style.display = "none";
    progress.style.display = "none";
    titleHeader.style.display = "block";

    const playlistContainer = document.getElementById("playlistContainer");
    if (playlistContainer) {
        const iframe = document.createElement("iframe");
        iframe.title = "Spotify Embed: Recommendation Playlist";
        iframe.src = `https://open.spotify.com/embed/playlist/${createdPlaylist.id}?utm_source=generator&theme=0`;
        iframe.width = "100%";
        iframe.height = "100%";
        iframe.style.minHeight = "360px";
        iframe.frameBorder = "0";
        iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
        iframe.loading = "lazy";
        iframe.onload = () => {
            const titleHeader = document.getElementById("titleHeader");
            if (titleHeader) titleHeader.style.display = "none";
        };
        playlistContainer.appendChild(iframe);
    }
}

function getRandomTracks(tracks, count) {
    if (tracks.length <= count) {
        return tracks;
    }
    const shuffled = tracks.sort(() => 0.5 - Math.random()); // Shuffle the array
    return shuffled.slice(0, count); // Get the first 'count' items
}

function smartShuffle(array, keyFn) {
    const groups = {};

    // Step 1: Group by artist name (or whatever keyFn returns)
    for (const item of array) {
        const key = keyFn(item);
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
    }

    // Step 2: Interleave
    const interleaved = [];
    let more = true;
    const values = Object.values(groups);

    while (more) {
        more = false;
        for (const group of values) {
            if (group.length) {
                interleaved.push(group.splice(Math.floor(Math.random() * group.length), 1)[0]);
                more = true;
            }
        }
    }

    return interleaved;
}

function requestAuthorization() {
    sessionStorage.clear();
    const clientId = "3629edd575284d0aa6671c69ae8fb3d3";
    const redirectUri = `${window.location.origin}/`;
    const scopes = [
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-currently-playing",
        "user-top-read",
        "user-read-recently-played",
        "playlist-modify-public",
        "playlist-modify-private",
        "user-library-read"
    ].join(" ");

    const url = `https://accounts.spotify.com/authorize?` +
        `client_id=${clientId}` +
        `&response_type=token` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(scopes)}` +
        `&show_dialog=true`;

    window.location = url;
}

function showArtists() {
    const start = document.getElementById("start");
    const getStartedButton = document.getElementById("getStartedButton");
    const artistsContainer = document.getElementById("showArtistsContainer"); // Add this line

    start.style.display = "none";
    getStartedButton.style.display = "none";

    getTopArtists().then(topArtists => {
        if (!artistsContainer) return;

        // Create header element
        const header = document.createElement("h2");
        header.textContent = "Select Your Favorite Artists";
        header.classList.add("artists-header");

        // Get the parent element of artistsContainer
        const parentElement = artistsContainer.parentElement;

        // Insert the header before the artistsContainer
        parentElement.insertBefore(header, artistsContainer);

        // Clear existing content
        artistsContainer.innerHTML = "";

        // Create elements for each artist
        topArtists.forEach(artist => {
            const artistElement = document.createElement("div");
            artistElement.classList.add("artists");
            artistElement.dataset.artistName = artist.name; // Store artist name as dataset

            const nameElement = document.createElement("div");
            nameElement.textContent = artist.name;
            nameElement.classList.add("artist-name");

            const imageElement = document.createElement("img");
            if (artist.images.length > 0) {
                imageElement.src = artist.images[0].url; // Use the first image
            }
            imageElement.classList.add("artist-image");

            // Add click event listener to artist element
            artistElement.addEventListener("click", () => {
                toggleArtistSelection(artistElement, artist.name);
            });

            // Append elements to the container
            artistElement.appendChild(imageElement);
            artistElement.appendChild(nameElement);
            artistsContainer.appendChild(artistElement);
        });
    }).catch(error => {
        console.error("Error fetching and displaying top artists:", error);
    });
}

function toggleArtistSelection(artistElement, artistName) {
    if (selectedArtists.includes(artistName)) {
        // Artist is already selected, remove from array and reset style
        const index = selectedArtists.indexOf(artistName);
        if (index > -1) {
            selectedArtists.splice(index, 1);
        }
        artistElement.classList.remove("selected");
    } else {
        // Artist is not selected, add to array and set style
        selectedArtists.push(artistName);
        artistElement.classList.add("selected");
    }

    if (selectedArtists.length >= 1) {
        createPlaylistButton.style.display = "block";
    } else {
        createPlaylistButton.style.display = "none";
    }

    console.log("Selected Artists:", selectedArtists);
}

function redirectToHomePage() {
    window.location.href = `${window.location.origin}/index.html`;
}

async function getRecommendationsForArtist(artistId, savedTrackNames) {
    const token = sessionStorage.getItem("access_token");
    const albumUrl = `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&market=US&limit=50`;

    const albumRes = await fetch(albumUrl, {
        headers: { Authorization: `Bearer ${token}` }
    });

    const albumData = await albumRes.json();
    const albumIds = [...new Set(
        albumData.items
            .filter(album => album.artists[0]?.id === artistId) // ✅ Ensure U2 is primary artist
            .map(album => album.id)
    )];

    let candidateTracks = [];

    for (const albumId of albumIds) {
        const tracksRes = await fetch(`https://api.spotify.com/v1/albums/${albumId}/tracks`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const trackData = await tracksRes.json();

        for (const track of trackData.items) {
            if (
                track.artists[0]?.id === artistId &&
                !savedTrackIdsSet.has(track.id) &&
                !savedTrackNames.has(track.name.toLowerCase())
            ) {
                candidateTracks.push(track);
            }
        }
    }

    // Remove duplicates by name
    const uniqueByName = [];
    const seenNames = new Set();
    for (const track of candidateTracks) {
        const nameLower = track.name.toLowerCase();
        if (!seenNames.has(nameLower)) {
            seenNames.add(nameLower);
            uniqueByName.push(track);
        }
    }

    return getRandomTracks(uniqueByName, 3);
}

async function displayTopTracks(timeRange) {
    const topTracks = await fetchWebApi(`v1/me/top/tracks?limit=50&time_range=${timeRange}`, 'GET');
    const tracksList = document.getElementById("topTracksList");

    // Iterate through the top tracks and create list items
    topTracks.items.forEach((track, index) => {
        const trackItem = document.createElement("li");
        trackItem.classList.add("track-item");

        // Create an anchor for the track
        const trackLink = document.createElement("a");
        trackLink.href = track.external_urls.spotify;
        trackLink.target = "_blank"; // Open link in a new tab
        trackLink.classList.add("track-link");

        // Create a div for the track
        const trackDiv = document.createElement("div");
        trackDiv.classList.add("track");

        // Create a div for the track number
        const trackNumberDiv = document.createElement("div");
        trackNumberDiv.classList.add("track-number");
        const trackNumber = document.createElement("span");
        trackNumber.textContent = index + 1;
        trackNumberDiv.appendChild(trackNumber);

        // Create an image element for the album artwork
        const albumImage = document.createElement("img");
        albumImage.src = track.album.images[0].url;
        albumImage.alt = "Album Artwork";
        albumImage.classList.add("album-image");

        // Create a div for track details
        const trackDetails = document.createElement("div");
        trackDetails.classList.add("track-details");

        // Create elements for track name and artist(s)
        const trackName = document.createElement("div");
        trackName.textContent = track.name;
        trackName.classList.add("track-name");

        const artists = document.createElement("div");
        artists.textContent = track.artists.map(artist => artist.name).join(', ');
        artists.classList.add("track-artists");

        // Append track number, album artwork, track name, and artist(s) to track div
        trackDiv.appendChild(trackNumberDiv);
        trackDiv.appendChild(albumImage);
        trackDetails.appendChild(trackName);
        trackDetails.appendChild(artists);
        trackDiv.appendChild(trackDetails);

        // Append track div to track link
        trackLink.appendChild(trackDiv);

        // Append track link to track item
        trackItem.appendChild(trackLink);

        // Append track item to tracks list
        tracksList.appendChild(trackItem);
    });
}

async function displayTopArtists(timeRange) {
    const topArtists = await fetchWebApi(`v1/me/top/artists?limit=50&time_range=${timeRange}`, 'GET');
    const artistsContainer = document.getElementById("artistsContainer");

    // Iterate through the top artists and create artist cards
    topArtists.items.forEach((artist, index) => {
        const artistCard = document.createElement("div");
        artistCard.classList.add("artist");

        // Create a div for the artist number
        const artistNumberDiv = document.createElement("div");
        artistNumberDiv.classList.add("artist-number");
        const artistNumber = document.createElement("span");
        artistNumber.textContent = index + 1;
        artistNumberDiv.appendChild(artistNumber);

        // Create an anchor for the artist's Spotify page
        const artistLink = document.createElement("a");
        artistLink.href = artist.external_urls.spotify;
        artistLink.target = "_blank"; // Open link in a new tab

        // Create a div for the artist image and name
        const artistContent = document.createElement("div");
        artistContent.classList.add("artist-content");

        // Create an image element for the artist picture
        const artistImage = document.createElement("img");
        artistImage.src = artist.images[0].url;
        artistImage.alt = "Artist Picture";
        artistImage.classList.add("artist-image");

        // Create a div for the artist name
        const artistName = document.createElement("div");
        artistName.textContent = artist.name;
        artistName.classList.add("artist-name");

        // Append artist image and name to the artist content div
        artistContent.appendChild(artistImage);
        artistContent.appendChild(artistName);

        // Append artist content to the artist link
        artistLink.appendChild(artistContent);

        // Append artist number and artist link to the artist card
        artistCard.appendChild(artistNumberDiv);
        artistCard.appendChild(artistLink);

        // Append artist card to the artists container
        artistsContainer.appendChild(artistCard);
    });
}

async function displayRecentTracks() {
    await displayCurrentlyPlayingTrack(); // Call to display currently playing track

    const recentTracks = await fetchWebApi('v1/me/player/recently-played?limit=50', 'GET');
    console.log("Recent tracks response:", recentTracks);
    const tracksList = document.getElementById("recentList");

    // Iterate through the recent tracks and create list items
    recentTracks.items.forEach((track, index) => {
        const trackItem = document.createElement("div");
        trackItem.classList.add("track-item");

        // Create an anchor for the track
        const trackLink = document.createElement("a");
        trackLink.href = track.track.external_urls.spotify;
        trackLink.target = "_blank"; // Open link in a new tab
        trackLink.classList.add("track-link");

        // Create a div for the track
        const trackDiv = document.createElement("div");
        trackDiv.classList.add("track");

        // Create a div for the track number
        const trackNumberDiv = document.createElement("div");
        trackNumberDiv.classList.add("track-number");
        const trackNumber = document.createElement("span");
        trackNumber.textContent = index + 1;
        trackNumberDiv.appendChild(trackNumber);

        // Create an image element for the album artwork
        const albumImage = document.createElement("img");
        albumImage.src = track.track.album.images[0].url;
        albumImage.alt = "Album Artwork";
        albumImage.classList.add("album-image");

        // Create a div for track details
        const trackDetails = document.createElement("div");
        trackDetails.classList.add("track-details");

        // Create elements for track name, artist(s), and played_at time
        const trackName = document.createElement("div");
        trackName.textContent = track.track.name;
        trackName.classList.add("track-name");

        const artists = document.createElement("div");
        artists.textContent = track.track.artists.map(artist => artist.name).join(', ');
        artists.classList.add("track-artists");

        // Calculate played at date
        const playedAt = document.createElement("div");
        const playedDate = new Date(track.played_at);
        const currentDate = new Date();
        const yesterday = new Date(currentDate);
        yesterday.setDate(currentDate.getDate() - 1);

        let playedDateStr = '';
        if (isSameDate(playedDate, currentDate)) {
            playedDateStr = "Today";
        } else if (isSameDate(playedDate, yesterday)) {
            playedDateStr = "Yesterday";
        } else {
            playedDateStr = formatDate(playedDate);
        }

        // Format played time
        const playedTime = playedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        playedAt.textContent = `Played: ${playedDateStr} at ${playedTime}`;
        playedAt.classList.add("played");

        // Append track number, album artwork, track name, artist(s), and played_at to track div
        trackDiv.appendChild(trackNumberDiv);
        trackDiv.appendChild(albumImage);
        trackDetails.appendChild(trackName);
        trackDetails.appendChild(artists);
        trackDetails.appendChild(playedAt);
        trackDiv.appendChild(trackDetails);

        // Append track div to track link
        trackLink.appendChild(trackDiv);

        // Append track link to track item
        trackItem.appendChild(trackLink);

        // Append track item to tracksList
        tracksList.appendChild(trackItem);
    });
}

async function displayCurrentlyPlayingTrack() {
    try {
        const currentlyPlayingTrack = await fetchWebApi('v1/me/player/currently-playing', 'GET');
        const currentTrackElement = document.getElementById("recentList");

        if (!currentlyPlayingTrack || !currentlyPlayingTrack.item) {
            console.log("No track is currently playing.");
            return;
        }

        const track = currentlyPlayingTrack.item;

        const trackDiv = document.createElement("div");
        trackDiv.classList.add("track");

        const musicBar = document.createElement("div");
        musicBar.classList.add("now", "playing");
        musicBar.id = "music";
        musicBar.innerHTML = `
            <span class="bar n1"></span>
            <span class="bar n2"></span>
            <span class="bar n3"></span>
            <span class="bar n4"></span>
            <span class="bar n5"></span>
        `;
        trackDiv.appendChild(musicBar);

        const artworkAndInfoDiv = document.createElement("div");
        artworkAndInfoDiv.classList.add("artwork-info");

        const albumDiv = document.createElement("div");
        albumDiv.classList.add("album-div");

        const albumImage = document.createElement("img");
        albumImage.src = track.album.images[0].url;
        albumImage.alt = "Album Artwork";
        albumImage.classList.add("album-image");

        albumDiv.appendChild(albumImage);

        const trackDetails = document.createElement("div");
        trackDetails.classList.add("track-details");

        const trackName = document.createElement("div");
        trackName.textContent = track.name;
        trackName.classList.add("track-name");

        const artists = document.createElement("div");
        artists.textContent = track.artists.map(artist => artist.name).join(', ');
        artists.classList.add("track-artists");

        trackDetails.appendChild(trackName);
        trackDetails.appendChild(artists);

        artworkAndInfoDiv.appendChild(albumDiv);
        artworkAndInfoDiv.appendChild(trackDetails);

        const trackLink = document.createElement("a");
        trackLink.href = track.external_urls.spotify;
        trackLink.target = "_blank";
        trackLink.classList.add("track-link");
        trackLink.appendChild(artworkAndInfoDiv);

        trackDiv.appendChild(trackLink);
        currentTrackElement.appendChild(trackDiv);
    } catch (error) {
        console.error("Error displaying currently playing track:", error);
    }
}

function isSameDate(date1, date2) {
    return date1.getFullYear() === date2.getFullYear() &&
        date1.getMonth() === date2.getMonth() &&
        date1.getDate() === date2.getDate();
}

function formatDate(date) {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const month = monthNames[date.getMonth()];
    const day = date.getDate();

    return `${month} ${day}`;
}