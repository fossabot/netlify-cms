import { get, isEmpty, concat, without, flatten, flatMap, initial } from 'lodash';
import u from 'unist-builder';

/**
 * Map of Slate node types to MDAST/Remark node types.
 */
const typeMap = {
  'root': 'root',
  'paragraph': 'paragraph',
  'heading-one': 'heading',
  'heading-two': 'heading',
  'heading-three': 'heading',
  'heading-four': 'heading',
  'heading-five': 'heading',
  'heading-six': 'heading',
  'quote': 'blockquote',
  'code': 'code',
  'numbered-list': 'list',
  'bulleted-list': 'list',
  'list-item': 'listItem',
  'table': 'table',
  'table-row': 'tableRow',
  'table-cell': 'tableCell',
  'thematic-break': 'thematicBreak',
  'link': 'link',
  'image': 'image',
};


/**
 * Map of Slate mark types to MDAST/Remark node types.
 */
const markMap = {
  bold: 'strong',
  italic: 'emphasis',
  strikethrough: 'delete',
  code: 'inlineCode',
};


/**
 * Slate treats inline code decoration as a standard mark, but MDAST does
 * not allow inline code nodes to contain children, only a single text
 * value. An MDAST inline code node can be nested within mark nodes such
 * as "emphasis" and "strong", but it cannot contain them.
 *
 * Because of this, if a "code" mark (translated to MDAST "inlineCode") is
 * in the markTypes array, we make the base text node an "inlineCode" type
 * instead of a standard text node.
 */
function processCodeMark(markTypes) {
  const isInlineCode = markTypes.includes('inlineCode');
  const filteredMarkTypes = isInlineCode ? without(markTypes, 'inlineCode') : markTypes;
  const textNodeType = isInlineCode ? 'inlineCode' : 'html';
  return { filteredMarkTypes, textNodeType };
}


/**
 * Returns an array of one or more MDAST text nodes of the given type, derived
 * from the text received. Certain transformations, such as line breaks, cause
 * multiple nodes to be returned.
 */
function createTextNodes(text, type = 'html') {
  /**
   * Split the text string at line breaks, then map each substring to an array
   * pair consisting of an MDAST text node followed by a break node. This will
   * result in nested arrays, so we use `flatMap` to produce a flattened array,
   * and `initial` to leave off the superfluous trailing break.
   */
  const brokenText = text.split('\n');
  const toPair = str => [u(type, str), u('break')];
  return initial(flatMap(brokenText, toPair));
}


/**
 * Wraps a text node in one or more mark nodes by placing the text node in an
 * array and using that as the `children` value of a mark node. The resulting
 * mark node is then placed in an array and used as the child of a mark node for
 * the next mark type in `markTypes`. This continues for each member of
 * `markTypes`. If `markTypes` is empty, the original text node is returned.
 */
function wrapTextWithMarks(textNode, markTypes) {
  const wrapTextWithMark = (childNode, markType) => u(markType, [childNode]);
  return markTypes.reduce(wrapTextWithMark, textNode);
}

/**
 * Converts a Slate Raw text node to an MDAST text node.
 *
 * Slate text nodes without marks often simply have a "text" property with
 * the value. In this case the conversion to MDAST is simple. If a Slate
 * text node does not have a "text" property, it will instead have a
 * "ranges" property containing an array of objects, each with an array of
 * marks, such as "bold" or "italic", along with a "text" property.
 *
 * MDAST instead expresses such marks in a nested structure, with individual
 * nodes for each mark type nested until the deepest mark node, which will
 * contain the text node.
 *
 * To convert a Slate text node's marks to MDAST, we treat each "range" as a
 * separate text node, convert the text node itself to an MDAST text node,
 * and then recursively wrap the text node for each mark, collecting the results
 * of each range in a single array of child nodes.
 *
 * For example, this Slate text node:
 *
 * {
 *   kind: 'text',
 *   ranges: [
 *     {
 *       text: 'test',
 *       marks: ['bold', 'italic']
 *     },
 *     {
 *       text: 'test two'
 *     }
 *   ]
 * }
 *
 * ...would be converted to this MDAST nested structure:
 *
 * [
 *   {
 *     type: 'strong',
 *     children: [{
 *       type: 'emphasis',
 *       children: [{
 *         type: 'text',
 *         value: 'test'
 *       }]
 *     }]
 *   },
 *   {
 *     type: 'text',
 *     value: 'test two'
 *   }
 * ]
 *
 * This example also demonstrates how a single Slate node may need to be
 * replaced with multiple MDAST nodes, so the resulting array must be flattened.
 */
function convertTextNode(node) {

  /**
   * If the Slate text node has no "ranges" property, just return an equivalent
   * MDAST node.
   */
  if (!node.ranges) {
    return createTextNodes(node.text);
  }

  /**
   * If there is no "text" property, convert the text range(s) to an array of
   * one or more nested MDAST nodes.
   */
  const textNodes = node.ranges.map(range => {
    /**
     * Get an array of the mark types, converted to their MDAST equivalent
     * types.
     */
    const { marks = [], text } = range;
    const markTypes = marks.map(mark => markMap[mark.type]);

    /**
     * Code marks must be removed from the marks array, and the presence of a
     * code mark changes the text node type that should be used.
     */
    const { filteredMarkTypes, textNodeType } = processCodeMark(markTypes);

    /**
     * Create the base text node.
     */
    const textNodes = createTextNodes(text, textNodeType);

    /**
     * Recursively wrap the base text node in the individual mark nodes, if
     * any exist.
     */
    return textNodes.map(textNode => wrapTextWithMarks(textNode, filteredMarkTypes));
  });

  /**
   * Since each range will be mapped into an array, we flatten the result to
   * return a single array of all nodes.
   */
  return flatten(textNodes);
}


/**
 * Convert a single Slate Raw node to an MDAST node. Uses the unist-builder `u`
 * function to create MDAST nodes and parses shortcodes.
 */
function convertNode(node, children, shortcodePlugins) {
  switch (node.type) {

    /**
     * General
     *
     * Convert simple cases that only require a type and children, with no
     * additional properties.
     */
    case 'root':
    case 'paragraph':
    case 'quote':
    case 'list-item':
    case 'table':
    case 'table-row':
    case 'table-cell': {
      return u(typeMap[node.type], children);
    }

    /**
     * Shortcodes
     *
     * Shortcode nodes only exist in Slate's Raw AST if they were inserted
     * via the plugin toolbar in memory, so they should always have
     * shortcode data attached. The "shortcode" data property contains the
     * name of the registered shortcode plugin, and the "shortcodeData" data
     * property contains the data received from the shortcode plugin's
     * `fromBlock` method when the shortcode node was created.
     *
     * Here we get the shortcode plugin from the registry and use it's
     * `toBlock` method to recreate the original markdown shortcode. We then
     * insert that text into a new "html" type node (a "text" type node
     * might get encoded or escaped by remark-stringify). Finally, we wrap
     * the "html" node in a "paragraph" type node, as shortcode nodes must
     * be alone in their own paragraph.
     */
    case 'shortcode': {
      const { data } = node;
      const plugin = shortcodePlugins.get(data.shortcode);
      const text = plugin.toBlock(data.shortcodeData);
      const textNode = u('html', text);
      return u('paragraph', { data }, [ textNode ]);
    }

    /**
     * Headings
     *
     * Slate schemas don't usually infer basic type info from data, so each
     * level of heading is a separately named type. The MDAST schema just
     * has a single "heading" type with the depth stored in a "depth"
     * property on the node. Here we derive the depth from the Slate node
     * type - e.g., for "heading-two", we need a depth value of "2".
     */
    case 'heading-one':
    case 'heading-two':
    case 'heading-three':
    case 'heading-four':
    case 'heading-five':
    case 'heading-six': {
      const depthMap = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
      const depthText = node.type.split('-')[1];
      const depth = depthMap[depthText];
      return u(typeMap[node.type], { depth }, children);
    }

    /**
     * Code Blocks
     *
     * Code block nodes have a single text child, and may have a code language
     * stored in the "lang" data property. Here we transfer both the node
     * value and the "lang" data property to the new MDAST node.
     */
    case 'code': {
      const value = get(node.nodes, [0, 'text']);
      const lang = get(node.data, 'lang');
      return u(typeMap[node.type], { lang }, value);
    }

    /**
     * Lists
     *
     * Our Slate schema has separate node types for ordered and unordered
     * lists, but the MDAST spec uses a single type with a boolean "ordered"
     * property to indicate whether the list is numbered. The MDAST spec also
     * allows for a "start" property to indicate the first number used for an
     * ordered list. Here we translate both values to our Slate schema.
     */
    case 'numbered-list':
    case 'bulleted-list': {
      const ordered = node.type === 'numbered-list';
      const props = { ordered, start: get(node.data, 'start') || 1 };
      return u(typeMap[node.type], props, children);
    }

    /**
     * Thematic Breaks
     *
     * Thematic breaks don't have children. We parse them separately for
     * clarity.
     */
    case 'thematic-break': {
      return u(typeMap[node.type]);
    }

    /**
     * Links
     *
     * The url and title attributes of link nodes are stored in properties on
     * the node for both Slate and Remark schemas.
     */
    case 'link': {
      const { url, title } = get(node, 'data', {});
      return u(typeMap[node.type], { url, title }, children);
    }

    /**
     * No default case is supplied because an unhandled case should never
     * occur. In the event that it does, let the error throw (for now).
     */
  }
}


export default function slateToRemark(raw, { shortcodePlugins }) {
  /**
   * The transform function mimics the approach of a Remark plugin for
   * conformity with the other serialization functions. This function converts
   * Slate nodes to MDAST nodes, and recursively calls itself to process child
   * nodes to arbitrary depth.
   */
  function transform(node) {

    /**
     * Call `transform` recursively on child nodes, and flatten the resulting
     * array.
     */
    const children = !isEmpty(node.nodes) && flatten(node.nodes.map(transform));

    /**
     * Run individual nodes through conversion factories.
     */
    return node.kind === 'text' ? convertTextNode(node) : convertNode(node, children, shortcodePlugins);
  }

  /**
   * The Slate Raw AST generally won't have a top level type, so we set it to
   * "root" for clarity.
   */
  raw.type = 'root';

  const mdast = transform(raw);
  return mdast;
}
