import matplotlib.pyplot as plt
import networkx as nx

from Graph import Graph   # adjust if your folder structure is different

def visualize_graph(graph: Graph, title="Graph Visualization"):
    G = nx.Graph()

    # Add nodes
    for key, node in graph.nodes.items():
        G.add_node(key)

    # Add edges
    for key, node in graph.nodes.items():
        for nbr in node.neighbors:
            # networkx needs basic types, not Node objects
            G.add_edge(key, nbr.key)

    plt.figure(figsize=(7, 7))
    pos = nx.spring_layout(G, seed=42)        # stable layout
    nx.draw(
        G, pos,
        with_labels=True,
        node_size=1000,
        node_color="#87CEFA",
        edge_color="#555",
        font_size=14,
        font_weight="bold"
    )
    plt.title(title)
    plt.show()


from Graph import Graph

g = Graph()
g.add_edge(1, 2)
g.add_edge(1, 3)
g.add_edge(2, 4)
g.add_edge(3, 5)
g.add_edge(4, 5)
visualize_graph(g, "Initial Graph")
