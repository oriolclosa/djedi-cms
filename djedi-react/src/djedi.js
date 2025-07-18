// This file does not contain anything React-specific. If need JS client for
// another framework this file could be extracted into its own package and be
// re-used.

import Cache from "./Cache";
import { applyUriDefaults, parseUri, stringifyUri } from "./uri";

const DEFAULT_CACHE_TTL = typeof window === "undefined" ? 20e3 : Infinity; // ms
const JSON_REGEX = /\bapplication\/json\b/;
const DOCUMENT_DOMAIN_REGEX = /\bdocument\.domain\s*=\s*(["'])([^'"\s]+)\1/;
const UPDATE_ADMIN_SIDEBAR_TIMEOUT = 100; // ms

/*
This class fetches and caches nodes, provides global options, and keeps
`window.DJEDI_NODES` up-to-date.
*/
export class Djedi {
  constructor() {
    this.options = makeDefaultOptions();

    // `Cache<uri: string, Node>`. Cache of all fetched nodes.
    this._nodes = new Cache({ ttl: DEFAULT_CACHE_TTL });

    // `Map<uri: string, { node: Node, needsRefresh: boolean }>`. Tracks
    // everything that `reportPrefetchableNode` has reported. The nodes contain
    // default values (if any). The boolean tells whether the node should be
    // re-fetched.
    this._prefetchableNodes = new Map();

    // `{ [uri: string]: string }`. The return value of the last `track` call.
    // Mutated by `get` and `getBatched`. The values come from fetched nodes.
    this._lastTrack = {};

    // Queue for `getBatched`.
    this._batch = makeEmptyBatch();

    // `Map<uri: string, number>`. Tracks everything that `reportRenderedNode`
    // has reported. The number shows how many nodes of the `uri` in question
    // are rendered. Used to keep `_DJEDI_NODES` up-to-date.
    this._renderedNodes = new Map();

    // `{ [uri: string]: string }`. The values are default values (if any). //
    // The admin sidebar expects the following mapping of all rendered nodes on
    // the page: `window.DJEDI_NODES = { "<uri>": "<default>" }`.
    this._DJEDI_NODES = {};

    // Whenever a node is rendered or removed the admin sidebar needs to be
    // refreshed. This is used to batch that refreshing.
    this._updateAdminSidebarTimeoutId = undefined;
    // If a `<Node>` has a `runder` prop that initially returns `null`, we need
    // to observe the DOM as well to add an outline when the `<span>` finally
    // appears.
    this._mutationObserver = undefined;

    // Used to only warn about unknown languages once.
    this._warnedLanguages = new Set();

    if (typeof window !== "undefined") {
      if (window.DJEDI_NODES == null) {
        window.DJEDI_NODES = {};
      }
      this._DJEDI_NODES = window.DJEDI_NODES;
    }
  }

  resetOptions() {
    this.options = makeDefaultOptions();
  }

  resetState() {
    // istanbul ignore next
    if (this._batch.timeoutId != null) {
      clearTimeout(this._batch.timeoutId);
    }
    // istanbul ignore next
    if (this._updateAdminSidebarTimeoutId != null) {
      clearTimeout(this._updateAdminSidebarTimeoutId);
    }
    // istanbul ignore next
    if (this._mutationObserver != null) {
      this._mutationObserver.disconnect();
    }

    this._nodes = new Cache({ ttl: DEFAULT_CACHE_TTL });
    this._prefetchableNodes = new Map();
    this._lastTrack = {};
    this._batch = makeEmptyBatch();
    this._renderedNodes = new Map();
    this._DJEDI_NODES = {};
    this._updateAdminSidebarTimeoutId = undefined;
    this._mutationObserver = undefined;
    this._warnedLanguages = new Set();

    if (typeof window !== "undefined") {
      window.DJEDI_NODES = this._DJEDI_NODES;
    }
  }

  setCache(ttl) {
    this._nodes.ttl = ttl;
  }

  get(passedNode, callback, { language = undefined } = {}) {
    const node = this._normalizeNode(passedNode, { language });
    const { uri } = node;
    const existing = this._nodes.get(uri);

    if (existing != null) {
      this._callback(callback, existing.node);

      if (!existing.needsRefresh) {
        return;
      }
    }

    this._fetchMany({ [node.uri]: node.value }).then(
      () => {
        if (existing == null) {
          const maybeNode = this._nodes.get(uri);
          this._callback(
            callback,
            maybeNode == null ? missingUriError(uri) : maybeNode.node
          );
        } else {
          // The node needed refresh and has now been refreshed and put into
          // cache. Nothing more to do.
        }
      },
      error => {
        if (existing == null) {
          this._callback(callback, error);
        } else {
          console.warn("djedi-react: Failed to refresh node", node, error);
        }
      }
    );
  }

  getBatched(passedNode, callback, { language = undefined } = {}) {
    if (this.options.batchInterval <= 0) {
      this.get(passedNode, callback, { language });
      return;
    }

    const node = this._normalizeNode(passedNode, { language });
    const existing = this._nodes.get(node.uri);

    if (existing != null) {
      this._callback(callback, existing.node);

      if (!existing.needsRefresh) {
        return;
      }
    }

    const previous = this._batch.queue.get(node.uri) || {
      node,
      callbacks: [],
    };
    previous.callbacks.push(
      existing == null
        ? callback
        : maybeNode => {
            if (maybeNode instanceof Error) {
              console.warn(
                "djedi-react: Failed to refresh node",
                node,
                maybeNode
              );
            } else {
              // The node needed refresh and has now been refreshed and put into
              // cache. Nothing more to do.
            }
          }
    );
    this._batch.queue.set(node.uri, previous);

    if (this._batch.timeoutId != null) {
      return;
    }

    this._batch.timeoutId = setTimeout(
      this._flushBatch.bind(this),
      this.options.batchInterval
    );
  }

  reportPrefetchableNode(node) {
    const previous = this._prefetchableNodes.get(node.uri);

    // During development, it is not uncommon to change defaults. If so, mark
    // the node re-fetching.
    const needsRefresh = previous != null && previous.node.value !== node.value;

    this._prefetchableNodes.set(node.uri, { node, needsRefresh });
  }

  prefetch({ filter = undefined, extra = [], language = undefined } = {}) {
    const nodes = {};
    this._prefetchableNodes.forEach(item => {
      const node = this._normalizeNode(item.node, { language });
      if (
        item.needsRefresh ||
        (this._nodes.get(node.uri) == null &&
          (filter == null ||
            filter(this._parseUri(node.uri, { applyDefaults: false }))))
      ) {
        nodes[node.uri] = node.value;
      }
    });
    extra.forEach(node => {
      const uri = this._normalizeUri(node.uri, { language });
      if (this._nodes.get(uri) == null) {
        nodes[uri] = node.value;
      }
    });

    const promise =
      Object.keys(nodes).length === 0
        ? Promise.resolve({})
        : this._fetchMany(nodes);

    return promise.then(() => undefined);
  }

  track() {
    this._lastTrack = {};
    return this._lastTrack;
  }

  // Needed to pick up the results from `prefetch` after server-side rendering.
  addNodes(nodes) {
    Object.keys(nodes).forEach(uri => {
      const uriObject = this._parseUri(uri);
      const value = nodes[uri];

      const node = { uri: this._stringifyUri(uriObject), value };
      this._nodes.set(node.uri, node);

      // If the returned node URI has a version, also set the versionless URI to
      // the same node. A request for `home/text.md` can return a URI ending
      // with for example `home/text.md#1` if the user has edited the node.
      if (uriObject.version) {
        const versionlessUri = this._stringifyUri({
          ...uriObject,
          version: "",
        });
        this._nodes.set(versionlessUri, node);
      }
    });
  }

  injectAdmin() {
    if (typeof document === "undefined") {
      return Promise.resolve(false);
    }

    const url = `${this.options.baseUrl}/embed/`;

    return this._fetch(url, { credentials: "include" }).then(response => {
      // If the user is not logged in as an admin, the API responds with 204 No
      // Content. Also handle 403 Forbidden for backwards compatibility.
      if (response.status === 204 || response.status === 403) {
        return false;
      }

      if (response.status >= 200 && response.status < 400) {
        return response.text().then(html => {
          // Browsers don’t allow <script> tags inserted as part of an HTML
          // chunk to modify `document.domain`, so cut out the domain and set it
          // manually.
          const [, , domain] = DOCUMENT_DOMAIN_REGEX.exec(html) || [];
          if (domain != null) {
            document.domain = domain;
          }

          // When hot-reloading code, remove any old iframe first.
          updateAdminSidebar({ remove: true });

          document.body.insertAdjacentHTML("beforeend", html);
          this._installMutationObserver();

          return true;
        });
      }

      return Promise.reject(createStatusCodeError(response));
    });
  }

  removeAdmin() {
    if (typeof document === "undefined") {
      return;
    }

    // istanbul ignore next
    if (this._updateAdminSidebarTimeoutId != null) {
      clearTimeout(this._updateAdminSidebarTimeoutId);
    }
    // istanbul ignore next
    if (this._mutationObserver != null) {
      this._mutationObserver.disconnect();
    }

    updateAdminSidebar({ remove: true });
  }

  reportRenderedNode(passedNode, { language = undefined } = {}) {
    const node = this._normalizeNode(passedNode, { language });
    const previous = this._renderedNodes.get(node.uri);
    const numInstances = previous == null ? 1 : previous + 1;

    this._renderedNodes.set(node.uri, numInstances);
    this._DJEDI_NODES[this._djediNodesUri(node.uri)] = node.value;

    // Always update the sidebar, to keep outlines up-to-date.
    this._updateAdminSidebar();
  }

  reportRemovedNode(passedUri, { language = undefined } = {}) {
    const uri = this._normalizeUri(passedUri, { language });
    const previous = this._renderedNodes.get(uri);

    if (previous == null) {
      return;
    }

    const numInstances = previous - 1;

    if (numInstances <= 0) {
      this._renderedNodes.delete(uri);
      delete this._DJEDI_NODES[this._djediNodesUri(uri)];
    } else {
      this._renderedNodes.set(uri, numInstances);
    }

    // Always update the sidebar, to keep outlines up-to-date.
    this._updateAdminSidebar();
  }

  element(uri) {
    const uriObject = this._parseUri(uri);
    return {
      tag: "span",
      attributes: {
        "data-i18n": this._stringifyUri({
          ...uriObject,
          scheme: "",
          ext: "",
          version: "",
        }),
      },
    };
  }

  // Calls `callback(node)` and also updates the last return value of
  // `djedi.track()`. This is really ugly but needed for server-side rendering.
  _callback(callback, node) {
    if (!(node instanceof Error)) {
      this._lastTrack[node.uri] = node.value;
    }
    callback(node);
  }

  _parseUri(
    uri,
    {
      applyDefaults = true,
      language: passedLanguage = this.options.languages.default,
    } = {}
  ) {
    const { defaults, namespaceByScheme, separators } = this.options.uri;
    const uriObject = parseUri(uri, separators);

    if (!applyDefaults) {
      return uriObject;
    }

    let language = passedLanguage;
    const allLanguages = [
      this.options.languages.default,
      ...this.options.languages.additional,
    ];

    if (allLanguages.indexOf(language) === -1) {
      const fallback = this.options.languages.default;
      if (!this._warnedLanguages.has(language)) {
        this._warnedLanguages.add(language);
        console.warn("djedi-react: Ignoring unknown language", {
          actual: language,
          expected: allLanguages,
          fallback,
        });
      }
      language = fallback;
    }

    return applyUriDefaults(uriObject, defaults, namespaceByScheme, {
      language,
    });
  }

  _stringifyUri(uriObject) {
    return stringifyUri(uriObject, this.options.uri.separators);
  }

  _normalizeUri(uri, { language = undefined }) {
    return this._stringifyUri(this._parseUri(uri, { language }));
  }

  _normalizeNode(node, { language = undefined }) {
    return {
      ...node,
      uri: this._normalizeUri(node.uri, { language }),
    };
  }

  _djediNodesUri(uri) {
    const uriObject = this._parseUri(uri);
    return this._stringifyUri({ ...uriObject, version: "" });
  }

  _flushBatch() {
    const { queue } = this._batch;

    const nodes = {};
    queue.forEach((data, uri) => {
      nodes[uri] = data.node.value;
    });

    this._batch = makeEmptyBatch();

    this._fetchMany(nodes).then(
      () => {
        queue.forEach((data, uri) => {
          const maybeNode = this._nodes.get(uri);
          const node =
            maybeNode == null ? missingUriError(uri) : maybeNode.node;
          data.callbacks.forEach(callback => {
            this._callback(callback, node);
          });
        });
      },
      error => {
        queue.forEach(data => {
          data.callbacks.forEach(callback => {
            this._callback(callback, error);
          });
        });
      }
    );
  }

  _fetchMany(nodes) {
    // `JSON.stringify` excludes keys whose values are `undefined`. Change them
    // to `null` so that all keys are sent to the backend.
    const nodesWithNull = Object.keys(nodes).reduce((result, key) => {
      const value = nodes[key];
      result[key] = value === undefined ? null : value;
      return result;
    }, {});
    return this._retrieve("/nodes/", nodesWithNull).then(results => {
      if (typeof results === "object" && results != null) {
        this.addNodes(results);
        return results;
      }
      return Promise.reject(
        new TypeError(
          `djedi-react: Expected the API to return an object of nodes, but got: ${JSON.stringify(
            results
          )}`
        )
      );
    });
  }

  _fetch(url, options) {
    const { fetch } = this.options;
    // `this.options.fetch(url, options)` does not work, since it calls the
    // function with `this.options` as context/`this` instead of `window`, which
    // the standard `fetch` function does not support (it throws an error).
    return fetch(url, options);
  }

  _retrieve(passedUrl, data) {
    const url = `${this.options.baseUrl}${passedUrl}`;
    return this._fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      body:
        // Make the body easier to read in test snapshots. It’s important to
        // still call `JSON.stringify` so we know that `data` actually can be
        // stringified.
        // istanbul ignore next
        // eslint-disable-next-line no-undef
        typeof process !== "undefined" && process.env.NODE_ENV === "test"
          ? JSON.parse(JSON.stringify(data))
          : JSON.stringify(data),
    })
      .then(
        response => {
          response.__input = data;
          const isJSON = JSON_REGEX.test(response.headers.get("Content-Type"));
          return (isJSON ? response.json() : response.text()).then(body => {
            response.__output = body;
            return response.status >= 200 && response.status < 400
              ? body
              : Promise.reject(createStatusCodeError(response));
          });
        },
        passedError => {
          // In IE11 the error can be a `ProgressEvent` (I guess it’s due to how
          // the `unfetch` “polyfill” is implemented). Make sure to always
          // return `Error`s so `foo instanceof Error` checks can be used.
          // istanbul ignore next
          const error =
            passedError instanceof Error
              ? passedError
              : new Error("fetch error");
          return Promise.reject(error);
        }
      )
      .catch(error => {
        const { response } = error;
        error.message = `djedi-react: ${
          response == null
            ? "(no response)"
            : `${response.status} ${response.statusText}`
        } POST ${url}:\n${error.message}`;
        return Promise.reject(error);
      });
  }

  _updateAdminSidebar() {
    if (this._updateAdminSidebarTimeoutId != null) {
      clearTimeout(this._updateAdminSidebarTimeoutId);
    }
    this._updateAdminSidebarTimeoutId = setTimeout(() => {
      this._updateAdminSidebarTimeoutId = undefined;
      updateAdminSidebar();
    }, UPDATE_ADMIN_SIDEBAR_TIMEOUT);
  }

  // There was no good way of testing `MutationObserver` when this was written,
  // so test the `_onMutation` method is tested instead.
  // istanbul ignore next
  _installMutationObserver() {
    if (typeof MutationObserver === "undefined") {
      return;
    }

    // When hot-reloading code, disconnect the old observer and install a new one.
    if (this._mutationObserver != null) {
      this._mutationObserver.disconnect();
    }

    this._mutationObserver = new MutationObserver(this._onMutation.bind(this));

    this._mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  _onMutation(records) {
    const element = this.element("");

    function isNodeWrapper(domNode) {
      return (
        domNode.nodeName === element.tag.toUpperCase() &&
        Object.keys(element.attributes).every(attribute =>
          domNode.hasAttribute(attribute)
        )
      );
    }

    function needsUpdate(domNodes) {
      return [].some.call(domNodes, domNode => {
        return (
          isNodeWrapper(domNode) ||
          (domNode.querySelectorAll != null &&
            [].some.call(domNode.querySelectorAll("*"), isNodeWrapper))
        );
      });
    }

    records.forEach(record => {
      if (needsUpdate(record.addedNodes) || needsUpdate(record.removedNodes)) {
        this._updateAdminSidebar();
      }
    });
  }
}

// This is a function, not a constant, since it can be mutated by the user.
function makeDefaultOptions() {
  return {
    baseUrl: "/djedi",
    batchInterval: 10, // ms
    defaultRender: state => {
      switch (state.type) {
        case "loading":
          return "Loading…";
        case "error":
          return `Failed to fetch content 😞 (${
            state.error.response != null ? state.error.response.status : -1
          })`;
        case "success":
          return state.content;
        // istanbul ignore next
        default:
          return null;
      }
    },
    fetch: defaultFetch,
    languages: {
      default: "en-us",
      additional: [],
    },
    uri: {
      defaults: {
        scheme: "i18n",
        namespace: "",
        path: "",
        ext: "txt",
        version: "",
      },
      namespaceByScheme: {
        i18n: "{language}",
        l10n: "local",
        g11n: "global",
      },
      separators: {
        scheme: "://",
        namespace: "@",
        path: "/",
        ext: ".",
        version: "#",
      },
    },
  };
}

function defaultFetch() {
  throw new Error("djedi-react: You must set `djedi.options.fetch`.");
}

// This is a function, not a constant, since it will be mutated.
function makeEmptyBatch() {
  return {
    timeoutId: undefined,
    queue: new Map(),
  };
}

function createStatusCodeError(response) {
  const error = new Error(`Non-success status code: ${response.status}`);
  error.response = response;
  return error;
}

function missingUriError(uri) {
  return new Error(`Missing result for node: ${uri}`);
}

function updateAdminSidebar({ remove = false } = {}) {
  if (typeof document === "undefined") {
    return;
  }

  const iframe = document.getElementById("djedi-cms");

  if (iframe == null) {
    return;
  }

  // The sidebar sets a width on `<html>` when the sidebar is open.
  document.documentElement.style.width = "";

  // Remove old outline elements.
  [].forEach.call(document.querySelectorAll(".djedi-node-outline"), element => {
    element.parentNode.removeChild(element);
  });

  if (remove) {
    // Remove the iframe.
    iframe.parentNode.removeChild(iframe);
  } else {
    // Reload the iframe.
    // eslint-disable-next-line no-self-assign
    iframe.src = iframe.src;
  }
}

export default new Djedi();
