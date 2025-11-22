class Node: 
    def __init__(self, key):
        self.key = key
        self.neighbors = set() # set of Node objects

    def add_neighbor(self, neighbor):
        self.neighbors.add(neighbor)

    def set_key(self, key):
        self.key = key

    def get_neighbors(self):
        return self.neighbors

    def set_neighbors(self, neighbors):
        self.neighbors = set(neighbors)

    def __hash__(self):
        return hash(self.key)

    def __eq__(self, other):
        return isinstance(other, Node) and self.key == other.key


