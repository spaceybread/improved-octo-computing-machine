from Node import Node

class Graph:
    def __init__(self):
        self.nodes = {} # { key : Node }

    def add_node(self, key) -> Node:
        if key not in self.nodes:
            self.nodes[key] = Node(key)
        return self.nodes[key]

    def remove_node(self, key):
        if key not in self.nodes:
            return
        
        u = self.nodes[key]
        for v in list(u.neighbors):
            v.neighbors.discard(u)
        del self.nodes[key]
     
    def add_edge(self, u, v):
        u_node = self.add_node(u)
        v_node = self.add_node(v)
        u_node.neighbors.add(v_node)
        v_node.neighbors.add(u_node)

    def remove_edge(self, u, v):
        if u not in self.nodes or v not in self.nodes:
            return False
        u_node = self.nodes[u]
        v_node = self.nodes[v]
        u_node.neighbors.discard(v_node)
        v_node.neighbors.discard(u_node)
        return True
    
    def neighbors(self, key):
        return [n.key for n in self.nodes[key].neighbors]